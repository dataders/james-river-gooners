"""Hermetic unit tests for the pipeline-metrics capture (no DuckDB / MotherDuck).

duckdb is imported lazily inside _connect(), so parse_run_results is testable
without it.
"""

import capture

SAMPLE = {
    "metadata": {"invocation_id": "abc-123", "generated_at": "2026-06-13T17:00:00Z"},
    "results": [
        {
            "unique_id": "model.gooners_analytics.fct_price_accuracy",
            "status": "success",
            "execution_time": 0.58,
            "adapter_response": {"rows_affected": 2637},
            "message": "OK",
        },
        {
            "unique_id": "test.gooners_analytics.not_null_stg_lots_item_id",
            "status": "pass",
            "execution_time": 0.12,
            "adapter_response": {},
            "message": None,
        },
        {
            "unique_id": "test.gooners_analytics.accepted_values_x",
            "status": "fail",
            "execution_time": 0.2,
            "adapter_response": {"rows_affected": 3},
            "message": "Got 3 results, configured to fail if != 0",
        },
    ],
}


def test_parse_run_results_shapes_each_node():
    rows = capture.parse_run_results(SAMPLE)
    assert len(rows) == 3

    model = rows[0]
    assert model["invocation_id"] == "abc-123"
    assert model["generated_at"] == "2026-06-13T17:00:00Z"
    assert model["resource_type"] == "model"
    assert model["name"] == "fct_price_accuracy"
    assert model["status"] == "success"
    assert model["rows_affected"] == 2637
    assert model["execution_time"] == 0.58

    passed_test = rows[1]
    assert passed_test["resource_type"] == "test"
    assert passed_test["status"] == "pass"
    assert passed_test["rows_affected"] is None  # no rows_affected in adapter_response
    assert passed_test["message"] == ""  # None message → ""

    failed_test = rows[2]
    assert failed_test["resource_type"] == "test"
    assert failed_test["status"] == "fail"
    assert failed_test["rows_affected"] == 3


def test_parse_run_results_empty():
    assert capture.parse_run_results({"results": []}) == []
    assert capture.parse_run_results({}) == []


def test_message_truncated():
    doc = {
        "metadata": {"invocation_id": "i", "generated_at": "t"},
        "results": [
            {"unique_id": "model.p.m", "status": "error", "message": "x" * 999}
        ],
    }
    assert len(capture.parse_run_results(doc)[0]["message"]) == 500


def test_source_schemas_are_warehouse_native():
    # The snapshot covers the dlt/export-loaded source schemas, not the mart schemas.
    assert "supabase_app" in capture.SOURCE_SCHEMAS
    assert "github_stats" in capture.SOURCE_SCHEMAS
    assert "gooners" not in capture.SOURCE_SCHEMAS
