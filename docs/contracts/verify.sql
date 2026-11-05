-- Run after schema.sql in an empty disposable database. All fixtures roll back.
BEGIN;
DO $test$
DECLARE
  org_a uuid := gen_random_uuid(); org_b uuid := gen_random_uuid();
  buyer uuid := gen_random_uuid(); qa uuid := gen_random_uuid(); ord uuid := gen_random_uuid();
  cat uuid; svc uuid; tpl uuid; offer uuid; ln uuid; pos uuid; pkg uuid; item uuid; link uuid; task uuid;
  rpt uuid; ver uuid; before_count integer; i integer; other_item uuid;
BEGIN
  INSERT INTO users(id) VALUES(buyer),(qa);
  INSERT INTO organizations(id,name) VALUES(org_a,'buyer'),(org_b,'other');
  INSERT INTO memberships VALUES(buyer,org_a,'owner');
  INSERT INTO customer_receiving_profiles(user_id,receiving_code,org_id) VALUES(buyer,'test-personal',org_a);
  INSERT INTO packages(code,org_id,received_by,received_at,state) VALUES('P-before-order',org_a,qa,now(),'checked_in') RETURNING id INTO pkg;
  INSERT INTO warehouse_items(code,org_id,package_id,intake_batch_id,identity_state,condition_state,custody_state,received_at)
    SELECT 'S-'||n,org_a,pkg,pkg,'identified','intact','stored',now() FROM generate_series(1,30) n;
  INSERT INTO orders(id,public_no,org_id,created_by) VALUES(ord,'test-order',org_a,buyer);
  INSERT INTO service_types(code,labels) VALUES('inspection','{}') RETURNING id INTO svc;
  FOR i IN 1..2 LOOP
    INSERT INTO categories(slug,labels,status) VALUES('shadow-'||i,'{}','PLANNED') RETURNING id INTO cat;
    INSERT INTO template_versions(template_key,category_id,service_type_id,version,content,content_hash,state,author_id,reviewer_id)
      VALUES('test-'||i,cat,svc,1,'{}','hash','PUBLISHED',buyer,qa) RETURNING id INTO tpl;
    INSERT INTO service_offers(sku_code,service_type_id,title) VALUES('unit-'||i,svc,'{}') RETURNING id INTO offer;
    INSERT INTO offer_templates VALUES(offer,cat,svc,tpl);
    INSERT INTO order_lines(order_id,org_id,offer_id,category_id,template_version_id,quantity,options,attributes)
      VALUES(ord,org_a,offer,cat,tpl,15,'{}','{}') RETURNING id INTO ln;
    INSERT INTO expected_items(order_line_id,position,declared_fields) SELECT ln,n,'{}' FROM generate_series(1,15) n;
    INSERT INTO order_line_item_links(org_id,order_line_id,expected_item_id,item_id,linked_at)
      SELECT org_a,ln,e.id,w.id,now() FROM expected_items e JOIN warehouse_items w ON w.code='S-'||((i-1)*15+e.position) WHERE e.order_line_id=ln;
  END LOOP;
  SELECT count(*) INTO before_count FROM samples WHERE org_id=org_a;
  IF before_count<>30 THEN RAISE EXCEPTION 'expected 30 mapped items'; END IF;
  SELECT id,item_id,expected_item_id INTO link,item,pos FROM order_line_item_links WHERE order_line_id=ln LIMIT 1;
  BEGIN INSERT INTO order_line_item_links(org_id,order_line_id,expected_item_id,item_id,linked_at) VALUES(org_b,ln,pos,item,now());
    RAISE EXCEPTION 'accepted foreign organization'; EXCEPTION WHEN foreign_key_violation OR unique_violation THEN NULL; END;
  BEGIN UPDATE order_line_item_links SET org_id=org_b WHERE id=link;
    RAISE EXCEPTION 'reassigned tenant'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN INSERT INTO order_line_item_links(org_id,order_line_id,expected_item_id,item_id,linked_at) VALUES(org_a,ln,pos,item,now());
    RAISE EXCEPTION 'duplicate inventory assignment'; EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN UPDATE template_versions SET content='{"changed":true}' WHERE id=tpl;
    RAISE EXCEPTION 'rewrote published template'; EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO inspection_tasks(order_line_id,template_version_id,assignment_id,state) VALUES(ln,tpl,link,'READY') RETURNING id INTO task;
  INSERT INTO inspection_results(task_id,item_key,attempt,status,reason,method,is_final,recorded_by)
    VALUES(task,'lining',1,'NOT_APPLICABLE','No lining','visual',true,qa);
  BEGIN INSERT INTO inspection_results(task_id,item_key,attempt,status,method,is_final,recorded_by)
    VALUES(task,'depth',1,'NOT_TESTED','measure',true,qa);
    RAISE EXCEPTION 'accepted unexplained omission'; EXCEPTION WHEN check_violation THEN NULL; END;
  rpt:=gen_random_uuid();ver:=gen_random_uuid();
  INSERT INTO reports(id,order_id,public_no) VALUES(rpt,ord,'report');
  INSERT INTO report_versions(id,report_id,version,snapshot,created_by) VALUES(ver,rpt,1,'{}',buyer);
  BEGIN UPDATE report_versions SET state='published',published_at=now(),reviewed_by=qa WHERE id=ver;
    RAISE EXCEPTION 'published without PDF'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE report_versions SET pdf_key='r/v1.pdf',pdf_sha256=repeat('0',64),state='published',published_at=now(),reviewed_by=qa WHERE id=ver;
  BEGIN UPDATE report_versions SET snapshot='{"changed":true}' WHERE id=ver;
    RAISE EXCEPTION 'rewrote report'; EXCEPTION WHEN check_violation THEN NULL; END;
  DECLARE q uuid; fee uuid; other_fee uuid; pay uuid; d uuid; d2 uuid; batch uuid; box uuid; quote2 uuid;
  BEGIN
    INSERT INTO inspection_quotes(order_id,revision,line_snapshot,terms_snapshot,amount_cents,currency,expires_at,accepted_at)
      VALUES(ord,1,'[]','[]',15000,'USD',now()+interval '1 day',now()) RETURNING id INTO q;
    BEGIN UPDATE inspection_quotes SET amount_cents=1 WHERE id=q;
      RAISE EXCEPTION 'rewrote accepted price'; EXCEPTION WHEN check_violation THEN NULL; END;
    INSERT INTO charge_items(org_id,purpose,inspection_quote_id,amount_cents,currency,snapshot)
      VALUES(org_a,'inspection',q,15000,'USD','{}') RETURNING id INTO fee;
    pay := gen_random_uuid();
    INSERT INTO payments(id,charge_item_id,provider,amount_cents,state,idempotency_key)
      VALUES(pay,fee,'stripe',15000,'succeeded','test-pay');
    UPDATE charge_items SET applied_payment_id=pay WHERE id=fee;
    INSERT INTO disposition_requests(org_id,item_id,action,destination,authorization_snapshot,state,created_by)
      VALUES(org_a,item,'return_to_seller','{"address":"demo"}','{}','approved',buyer) RETURNING id INTO d;
    INSERT INTO dispatch_batches(org_id,destination_snapshot,action,revision,state)
      VALUES(org_a,'{"address":"demo"}','return_to_seller',1,'approved') RETURNING id INTO batch;
    INSERT INTO dispatch_batch_items VALUES(batch,item,d,org_a,NULL);
    INSERT INTO dispatch_quote_versions(batch_id,revision,snapshot,amount_cents,expires_at)
      VALUES(batch,1,'{}',200,now()+interval '1 day') RETURNING id INTO quote2;
    INSERT INTO charge_items(org_id,purpose,dispatch_quote_id,amount_cents,currency,snapshot)
      VALUES(org_a,'dispatch',quote2,200,'USD','{}') RETURNING id INTO other_fee;
    BEGIN UPDATE charge_items SET applied_payment_id=pay WHERE id=other_fee;
      RAISE EXCEPTION 'payment applied to two charges'; EXCEPTION WHEN unique_violation OR foreign_key_violation THEN NULL; END;
    INSERT INTO shipments(batch_id,weight_g,state,packed_media_ids) VALUES(batch,200,'packed','{}') RETURNING id INTO box;
    INSERT INTO shipment_items VALUES(box,batch,item);
    SELECT id INTO other_item FROM warehouse_items WHERE id<>item LIMIT 1;
    BEGIN INSERT INTO shipment_items VALUES(box,batch,other_item);
      RAISE EXCEPTION 'packed an unauthorized item'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    BEGIN UPDATE shipments SET state='shipped' WHERE id=box;
      RAISE EXCEPTION 'shipped without carrier or handover'; EXCEPTION WHEN check_violation THEN NULL; END;
  END;
END $test$;
ROLLBACK;
