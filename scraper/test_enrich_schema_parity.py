"""The image-search edge fn's tool schema must be a subset of enrich.py's schema,
so the photo report's identification fields line up with the scraper's enrichment."""
import re
from pathlib import Path

# The canonical enrichment field set (search-oriented v3/v6 fields the report uses).
EXPECTED_SUBSET = {
    "brand", "modelOrSku", "productType", "searchQuery", "condition",
    "brandConfidence", "modelConfidence",
}

def test_edge_schema_fields_are_enrichment_fields():
    # enrich.py is the source of truth for the field names.
    enrich_src = (Path(__file__).parent / "enrich.py").read_text()
    for field in EXPECTED_SUBSET:
        assert f'"{field}"' in enrich_src, f"{field} missing from enrich.py"

    # The edge fn must declare each of these as a tool-schema property. Match each
    # field by name rather than a fixed indentation (robust to reformatting): a
    # `<field>: {` declaration with a `type:` line shortly after.
    edge_src = (Path(__file__).parents[1] / "supabase/functions/image-search/index.ts").read_text()
    for field in {"brand", "productType", "searchQuery", "condition",
                  "brandConfidence", "modelConfidence"}:
        assert re.search(rf"\b{field}:\s*\{{\s*\n\s*type:", edge_src), \
            f"edge tool schema missing property {field}"
