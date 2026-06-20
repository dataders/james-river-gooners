-- Rename source_query='visual' → 'hybrid' in ebay_comp_snapshots.
--
-- The embedding-based comp path (Nomic text+image cosine) was originally stamped
-- 'visual' because the Nomic vision model contributes to the vector. 'hybrid' is
-- more accurate: the model fuses both text and image signals, so matches succeed
-- on descriptive text alone (e.g. "walnut credenza") even without a strong image.
-- The UI sort (ebayComps.js) and all writer paths are updated in the same deploy.

update ebay_comp_snapshots
set source_query = 'hybrid'
where source_query = 'visual';
