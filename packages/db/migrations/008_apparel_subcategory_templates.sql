CREATE INDEX IF NOT EXISTS template_versions_category_key_idx
  ON template_versions(category_id, template_key, version DESC);

CREATE OR REPLACE FUNCTION ensure_apparel_subcategory_catalog() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_category uuid;
  v_demo boolean := false;
  v_insp_svc uuid;
  v_comp_svc uuid;
  v_cap uuid;
  v_author uuid;
  v_reviewer uuid;
  v_tpl uuid;
  v_offer uuid;
  v_inserted integer := 0;
  v_rec record;
  v_comp_content jsonb;
BEGIN
  SELECT id, COALESCE((admission_snapshot->>'demo')::boolean, false)
    INTO v_category, v_demo
    FROM categories WHERE slug = 'apparel';
  IF v_category IS NULL THEN
    RETURN 0;
  END IF;

  SELECT id INTO v_insp_svc FROM service_types WHERE code = 'inspection';
  SELECT id INTO v_comp_svc FROM service_types WHERE code = 'compare';
  IF v_insp_svc IS NULL THEN
    RETURN 0;
  END IF;

  SELECT id INTO v_cap FROM capabilities WHERE approved_by IS NOT NULL AND revoked_at IS NULL ORDER BY id LIMIT 1;
  IF v_cap IS NULL THEN
    RETURN 0;
  END IF;

  SELECT author_id, reviewer_id INTO v_author, v_reviewer
    FROM template_versions
    WHERE category_id = v_category AND state = 'PUBLISHED' AND reviewer_id IS NOT NULL AND reviewer_id <> author_id
    ORDER BY published_at DESC NULLS LAST, version DESC LIMIT 1;
  IF v_author IS NULL OR v_reviewer IS NULL THEN
    SELECT sr1.user_id, sr2.user_id INTO v_author, v_reviewer
      FROM staff_roles sr1
      JOIN staff_roles sr2 ON sr2.user_id <> sr1.user_id
      WHERE sr1.role IN ('template_admin', 'super_admin')
        AND sr2.role IN ('reviewer', 'super_admin')
      ORDER BY sr1.user_id, sr2.user_id LIMIT 1;
  END IF;
  IF v_author IS NULL OR v_reviewer IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_rec IN
    SELECT * FROM (VALUES
      (
        'apparel-tops-inspection',
        'apparel-sub-tops-inspection-1',
        'tops',
        '{"en":"Tops & Knitwear Inspection","zh-CN":"上衣/针织衫专项质检"}'::jsonb,
        '{
          "subcategory": "tops",
          "measurement_policy": {"attempts": 2, "extra_attempt_on_difference": true, "threshold_by_unit": {"cm": 0.5, "g": 1}},
          "measure_conditions": "Garment laid flat on standard inspection table without stretching; relaxed for 15 minutes; steel tape calibrated to 0.1 cm.",
          "diagram": "/diagrams/tops.svg",
          "parts": [
            {"code": "collar", "label": "Collar / Neckband (领口)"},
            {"code": "shoulder_left", "label": "Left Shoulder Seam (左肩缝)"},
            {"code": "shoulder_right", "label": "Right Shoulder Seam (右肩缝)"},
            {"code": "chest_front", "label": "Front Chest Panel (前胸幅)"},
            {"code": "back_panel", "label": "Back Panel (后背幅)"},
            {"code": "sleeve_left", "label": "Left Sleeve & Cuff (左袖/袖口)"},
            {"code": "sleeve_right", "label": "Right Sleeve & Cuff (右袖/袖口)"},
            {"code": "side_seam", "label": "Side Seam (侧缝)"},
            {"code": "hem", "label": "Bottom Hem (下摆)"},
            {"code": "care_label", "label": "Main / Care Label (主唛/洗水唛)"}
          ],
          "shots": [
            {"code": "front_full", "name": "Front Full Flat Lay", "zh": "正面平铺全景", "required": true},
            {"code": "back_full", "name": "Back Full Flat Lay", "zh": "背面平铺全景", "required": true},
            {"code": "collar_label", "name": "Collar & Size/Brand Label", "zh": "领口与主唛微距", "required": true},
            {"code": "care_label_shot", "name": "Care & Composition Label", "zh": "洗水唛与成分标", "required": true},
            {"code": "inside_seams", "name": "Interior Seam & Overlock", "zh": "内里缝线与包边", "required": true},
            {"code": "chest_tape_shot", "name": "Chest Width Tape Photo", "zh": "胸宽拉尺实拍", "required": true}
          ],
          "checks": [
            {"key": "body_length_cm", "label": "Front Body Length HPS", "zh": "前衣长 (肩顶至下摆)", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/tops.svg", "required": true, "evidence": false, "method": "Measure from High Point Shoulder (HPS) vertically down to bottom hem."},
            {"key": "chest_flat_cm", "label": "1/2 Chest Width Flat", "zh": "平铺半胸围", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/tops.svg", "required": true, "evidence": false, "method": "Measure straight across chest 2.5cm below armhole seam."},
            {"key": "shoulder_width_cm", "label": "Shoulder Width", "zh": "肩宽", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/tops.svg", "required": true, "evidence": false, "method": "Measure straight from left shoulder point to right shoulder point."},
            {"key": "sleeve_length_cm", "label": "Sleeve Length", "zh": "袖长", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/tops.svg", "required": true, "evidence": false, "method": "Measure from shoulder seam apex along outer sleeve fold to cuff edge."},
            {"key": "hem_flat_cm", "label": "1/2 Bottom Hem Width", "zh": "平铺下摆宽", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/tops.svg", "required": true, "evidence": false, "method": "Measure straight across bottom sweep from left edge to right edge."},
            {"key": "neck_opening_cm", "label": "Neck Opening Width", "zh": "领口宽", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/tops.svg", "required": true, "evidence": false, "method": "Measure inside seam-to-seam across collar opening."},
            {"key": "unit_weight_g", "label": "Garment Unit Weight", "zh": "单件克重", "kind": "measurement", "type": "number", "unit": "g", "precision": 0.1, "retry_threshold": 1.0, "required": true, "evidence": false, "method": "Weigh single garment unpacked on calibrated digital scale."},
            {"key": "workmanship_seams", "label": "Seam & Stitching Workmanship", "zh": "车缝与线头外观", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["collar", "shoulder_left", "shoulder_right", "sleeve_left", "sleeve_right", "side_seam", "hem"], "method": "Inspect collar, cuffs, armholes, side seams, and hem for skipped stitches, puckering, or loose threads."},
            {"key": "fabric_surface", "label": "Fabric Surface & Stains", "zh": "面料外观与污渍", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["chest_front", "back_panel", "sleeve_left", "sleeve_right"], "method": "Check front/back panels under D65 light for oil stains, holes, snags, or shading."},
            {"key": "label_marking_check", "label": "Label & Size Marking Accuracy", "zh": "唛头与尺码核对", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["collar", "care_label"], "method": "Verify main label, size tag, and care label match order declaration."}
          ]
        }'::jsonb,
        true
      ),
      (
        'apparel-bottoms-inspection',
        'apparel-sub-bottoms-inspection-1',
        'bottoms',
        '{"en":"Bottoms, Pants & Leggings Inspection","zh-CN":"裤装/紧身裤专项质检"}'::jsonb,
        '{
          "subcategory": "bottoms",
          "measurement_policy": {"attempts": 2, "extra_attempt_on_difference": true, "threshold_by_unit": {"cm": 0.5, "g": 1}},
          "measure_conditions": "Garment laid flat on standard inspection table without stretching; relaxed for 15 minutes; steel tape calibrated to 0.1 cm.",
          "diagram": "/diagrams/bottoms.svg",
          "parts": [
            {"code": "waistband", "label": "Waistband (腰头)"},
            {"code": "crotch_gusset", "label": "Crotch / Gusset Seam (裆部/三角裤裆)"},
            {"code": "hip_panel", "label": "Hip / Seat Panel (臀围区)"},
            {"code": "thigh_left", "label": "Left Thigh & Inseam (左大腿/内长缝)"},
            {"code": "thigh_right", "label": "Right Thigh & Inseam (右大腿/内长缝)"},
            {"code": "outseam", "label": "Outer Side Seam (外侧缝)"},
            {"code": "leg_opening", "label": "Leg Opening / Ankle Cuff (脚口)"},
            {"code": "care_label", "label": "Size / Care Label (尺码/洗水唛)"}
          ],
          "shots": [
            {"code": "front_full", "name": "Front Full Flat Lay", "zh": "裤装正面平铺全景", "required": true},
            {"code": "back_full", "name": "Back Full Flat Lay", "zh": "裤装背面平铺全景", "required": true},
            {"code": "waistband_label", "name": "Waistband & Inner Print/Label", "zh": "腰头与尺码唛微距", "required": true},
            {"code": "crotch_gusset_shot", "name": "Crotch Gusset Flatlock Seam", "zh": "裆部四针六线缝合微距", "required": true},
            {"code": "waist_inseam_tape", "name": "Waist & Inseam Tape Photo", "zh": "腰围与内长拉尺实拍", "required": true}
          ],
          "checks": [
            {"key": "waist_flat_cm", "label": "1/2 Waist Width Relaxed", "zh": "平铺半腰围", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Align front and back top edges of waistband; measure straight across."},
            {"key": "hip_flat_cm", "label": "1/2 Hip Width Flat", "zh": "平铺半臀围", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Measure straight across hip at 18cm below top of waistband (or 5cm above crotch)."},
            {"key": "front_rise_cm", "label": "Front Rise incl. Waistband", "zh": "前浪长", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Measure from top center of front waistband along seam to crotch intersection."},
            {"key": "back_rise_cm", "label": "Back Rise incl. Waistband", "zh": "后浪长", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Measure from top center of back waistband along seam to crotch intersection."},
            {"key": "inseam_cm", "label": "Inseam Length", "zh": "内长/裤内长", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Measure from crotch seam intersection along inner leg seam to bottom ankle opening."},
            {"key": "outseam_cm", "label": "Outseam Total Length", "zh": "外裤长", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Measure from top outer edge of waistband along side to leg opening."},
            {"key": "leg_opening_flat_cm", "label": "1/2 Leg Opening Width", "zh": "平铺半脚口宽", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/bottoms.svg", "required": true, "evidence": false, "method": "Measure straight across bottom ankle/leg opening."},
            {"key": "unit_weight_g", "label": "Garment Unit Weight", "zh": "单件克重", "kind": "measurement", "type": "number", "unit": "g", "precision": 0.1, "retry_threshold": 1.0, "required": true, "evidence": false, "method": "Weigh single pants/leggings unpacked on calibrated digital scale."},
            {"key": "crotch_flatlock_check", "label": "Crotch Gusset & Flatlock Seam", "zh": "裆部拼缝与四针六线", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["waistband", "crotch_gusset", "thigh_left", "thigh_right", "outseam", "leg_opening"], "method": "Inspect crotch gusset and flatlock seams under gentle hand tension for grinning or skipped stitches."},
            {"key": "fabric_surface", "label": "Fabric Surface & Elasticity Feel", "zh": "面料外观与对称度", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["hip_panel", "thigh_left", "thigh_right", "leg_opening"], "method": "Inspect for snags, dye streaks, oil marks, or uneven leg symmetry."}
          ]
        }'::jsonb,
        true
      ),
      (
        'apparel-sports-bra-inspection',
        'apparel-sub-sports-bra-inspection-1',
        'sports_bra',
        '{"en":"Sports Bra & Intimate Activewear Inspection","zh-CN":"运动内衣专项质检"}'::jsonb,
        '{
          "subcategory": "sports_bra",
          "measurement_policy": {"attempts": 2, "extra_attempt_on_difference": true, "threshold_by_unit": {"cm": 0.5, "g": 1}},
          "measure_conditions": "Garment laid flat on standard inspection table with removable cups flat inside; steel tape calibrated to 0.1 cm.",
          "diagram": "/diagrams/sports_bra.svg",
          "parts": [
            {"code": "strap_left", "label": "Left Shoulder Strap (左肩带)"},
            {"code": "strap_right", "label": "Right Shoulder Strap (右肩带)"},
            {"code": "neckline_binding", "label": "Neckline / Armhole Binding (领圈/袖笼包边)"},
            {"code": "cup_lining", "label": "Inner Cup Lining & Pad Opening (胸垫内胆与插口)"},
            {"code": "removable_pads", "label": "Removable Bra Pads Pair (可拆卸胸垫对)"},
            {"code": "underbust_band", "label": "Underbust Elastic Band (下扒松紧带)"},
            {"code": "back_strap_cross", "label": "Back Cross / Clasp Area (后背交叉带/背扣)"}
          ],
          "shots": [
            {"code": "front_full", "name": "Front Full Flat Lay", "zh": "运动内衣正面平铺", "required": true},
            {"code": "back_full", "name": "Back Full Flat Lay", "zh": "运动内衣背面平铺", "required": true},
            {"code": "inner_lining_pads", "name": "Inner Cup Lining & Pads Removed", "zh": "内胆及胸垫取出同框照", "required": true},
            {"code": "underbust_tape", "name": "Underbust Band Tape Photo", "zh": "下扒宽拉尺实拍", "required": true}
          ],
          "checks": [
            {"key": "bust_flat_cm", "label": "1/2 Bust Width Flat", "zh": "平铺半胸围", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/sports_bra.svg", "required": true, "evidence": false, "method": "Measure straight across fullest part of chest 2cm below armhole."},
            {"key": "underbust_flat_cm", "label": "1/2 Underbust Band Relaxed", "zh": "平铺半下扒宽", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "derived": {"circumference_cm": "2x"}, "diagram": "/diagrams/sports_bra.svg", "required": true, "evidence": false, "method": "Measure straight across bottom edge of elastic underbust band relaxed."},
            {"key": "strap_to_hem_cm", "label": "Total Length HPS to Underbust", "zh": "肩带顶点至下扒总长", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/sports_bra.svg", "required": true, "evidence": false, "method": "Measure vertically from top of shoulder strap to bottom edge of underbust band."},
            {"key": "center_front_height_cm", "label": "Center Front Height", "zh": "前中高度", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.5, "diagram": "/diagrams/sports_bra.svg", "required": true, "evidence": false, "method": "Measure vertically from center front neckline down to bottom edge of band."},
            {"key": "band_height_cm", "label": "Underbust Elastic Band Height", "zh": "下扒松紧带高度", "kind": "measurement", "type": "number", "unit": "cm", "precision": 0.1, "retry_threshold": 0.3, "diagram": "/diagrams/sports_bra.svg", "required": true, "evidence": false, "method": "Measure vertical height of bottom elastic band."},
            {"key": "unit_weight_g", "label": "Garment Unit Weight incl. Pads", "zh": "含胸垫单件克重", "kind": "measurement", "type": "number", "unit": "g", "precision": 0.1, "retry_threshold": 1.0, "required": true, "evidence": false, "method": "Weigh sports bra with both pads inserted on digital scale."},
            {"key": "pad_symmetry_check", "label": "Removable Pads Symmetry & Smoothness", "zh": "胸垫对称度与平整度", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["cup_lining", "removable_pads"], "method": "Remove pads to inspect for creases, delamination, size mismatch, or rough pocket openings."},
            {"key": "strap_bar_tack_check", "label": "Strap Reinforcement & Binding Seams", "zh": "肩带打枣加固与包边车缝", "kind": "observation", "type": "text", "required": true, "evidence": false, "parts": ["strap_left", "strap_right", "neckline_binding", "underbust_band", "back_strap_cross"], "method": "Check strap joints, elastic band recovery, and binding seams for skipped stitches."}
          ]
        }'::jsonb,
        false
      )
    ) AS t(tpl_key, sku_code, sub_slug, title_json, content_json, with_compare)
  LOOP
    SELECT id INTO v_tpl FROM template_versions WHERE template_key = v_rec.tpl_key AND version = 1;
    IF v_tpl IS NULL THEN
      INSERT INTO template_versions(template_key, category_id, service_type_id, version, content, content_hash, state, author_id, reviewer_id, published_at)
        VALUES(v_rec.tpl_key, v_category, v_insp_svc, 1, v_rec.content_json, encode(sha256(convert_to(v_rec.content_json::text, 'UTF8')), 'hex'), 'PUBLISHED', v_author, v_reviewer, now())
        RETURNING id INTO v_tpl;
      INSERT INTO template_capabilities(template_version_id, capability_id) VALUES(v_tpl, v_cap) ON CONFLICT DO NOTHING;
      v_inserted := v_inserted + 1;
    END IF;

    SELECT id INTO v_offer FROM service_offers WHERE sku_code = v_rec.sku_code;
    IF v_offer IS NULL THEN
      INSERT INTO service_offers(sku_code, service_type_id, title, enabled)
        VALUES(v_rec.sku_code, v_insp_svc, v_rec.title_json, true)
        RETURNING id INTO v_offer;
      INSERT INTO offer_templates(offer_id, category_id, service_type_id, template_version_id)
        VALUES(v_offer, v_category, v_insp_svc, v_tpl) ON CONFLICT DO NOTHING;
      INSERT INTO sku_prices(offer_id, version, currency, rules, effective_from)
        VALUES(v_offer, 1, 'USD', jsonb_build_object('minimum', 1, 'maximum', 100, 'unit_cents', 3500, 'business_days', 3, 'demo', v_demo), now())
        ON CONFLICT DO NOTHING;
    END IF;

    IF v_rec.with_compare AND v_comp_svc IS NOT NULL THEN
      v_comp_content := v_rec.content_json || '{"order_shots":["side_by_side_front","side_by_side_back","detail_overlay"]}'::jsonb;
      SELECT id INTO v_tpl FROM template_versions WHERE template_key = 'apparel-' || v_rec.sub_slug || '-compare' AND version = 1;
      IF v_tpl IS NULL THEN
        INSERT INTO template_versions(template_key, category_id, service_type_id, version, content, content_hash, state, author_id, reviewer_id, published_at)
          VALUES('apparel-' || v_rec.sub_slug || '-compare', v_category, v_comp_svc, 1, v_comp_content, encode(sha256(convert_to(v_comp_content::text, 'UTF8')), 'hex'), 'PUBLISHED', v_author, v_reviewer, now())
          RETURNING id INTO v_tpl;
        INSERT INTO template_capabilities(template_version_id, capability_id) VALUES(v_tpl, v_cap) ON CONFLICT DO NOTHING;
        v_inserted := v_inserted + 1;
      END IF;

      SELECT id INTO v_offer FROM service_offers WHERE sku_code = 'apparel-sub-' || v_rec.sub_slug || '-compare-2';
      IF v_offer IS NULL THEN
        INSERT INTO service_offers(sku_code, service_type_id, title, enabled)
          VALUES(
            'apparel-sub-' || v_rec.sub_slug || '-compare-2',
            v_comp_svc,
            jsonb_build_object('en', (v_rec.title_json->>'en') || ' · 2-Item Comparison', 'zh-CN', (v_rec.title_json->>'zh-CN') || ' · 2件横向对比'),
            true
          )
          RETURNING id INTO v_offer;
        INSERT INTO offer_templates(offer_id, category_id, service_type_id, template_version_id)
          VALUES(v_offer, v_category, v_comp_svc, v_tpl) ON CONFLICT DO NOTHING;
        INSERT INTO sku_prices(offer_id, version, currency, rules, effective_from)
          VALUES(v_offer, 1, 'USD', jsonb_build_object('minimum', 2, 'maximum', 2, 'package_cents', 6500, 'business_days', 3, 'demo', v_demo), now())
          ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  RETURN v_inserted;
END $$;

SELECT ensure_apparel_subcategory_catalog();
