-- Test database only. Activate the two shadow categories through catalog data.
DO $$
DECLARE
  cfg record;
  category uuid;
  service uuid;
  author uuid;
  reviewer uuid;
  capability uuid;
  template uuid;
  offer uuid;
  content jsonb;
BEGIN
  SELECT id INTO STRICT service FROM service_types WHERE code='inspection';
  SELECT id INTO STRICT capability FROM capabilities WHERE code='demo-visual';
  SELECT author_id,reviewer_id INTO STRICT author,reviewer
    FROM template_versions WHERE template_key='apparel-inspection';
  FOR cfg IN SELECT * FROM (VALUES
    ('bags','Hardware condition','五金状态','Handle drop','提手垂直高度'),
    ('home','Surface finish','表面处理','Maximum height','最大高度')
  ) AS v(slug,visual_en,visual_zh,measure_en,measure_zh)
  LOOP
    UPDATE categories SET status='ACTIVE',admission_snapshot='{"demo":true}'
      WHERE slug=cfg.slug RETURNING id INTO STRICT category;
    IF EXISTS(SELECT 1 FROM service_offers WHERE sku_code=cfg.slug||'-shadow') THEN CONTINUE; END IF;
    content := jsonb_build_object('checks',jsonb_build_array(
      jsonb_build_object('key',cfg.slug||'_visual','label',cfg.visual_en,'zh',cfg.visual_zh,'type','boolean','method','Visual observation','required',true,'evidence',true),
      jsonb_build_object('key',cfg.slug||'_measure','label',cfg.measure_en,'zh',cfg.measure_zh,'type','number','unit','cm','method','Measure the vertical distance','required',true,'evidence',true)
    ));
    INSERT INTO template_versions(template_key,category_id,service_type_id,version,content,content_hash,state,author_id,reviewer_id,published_at)
      VALUES(cfg.slug||'-shadow',category,service,1,content,encode(sha256(convert_to(content::text,'UTF8')),'hex'),'PUBLISHED',author,reviewer,now()) RETURNING id INTO template;
    INSERT INTO template_capabilities VALUES(template,capability);
    INSERT INTO service_offers(sku_code,service_type_id,title,enabled)
      VALUES(cfg.slug||'-shadow',service,'{"en":"Item inspection","zh-CN":"逐件检查"}',true) RETURNING id INTO offer;
    INSERT INTO offer_templates VALUES(offer,category,service,template);
    INSERT INTO sku_prices(offer_id,version,currency,rules,effective_from)
      VALUES(offer,1,'USD','{"minimum":1,"maximum":100,"unit_cents":3500,"business_days":3,"demo":true}',now());
  END LOOP;
END $$;
