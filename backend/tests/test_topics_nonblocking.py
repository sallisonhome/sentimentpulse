"""Regression contracts for durable nonblocking dashboard topics."""
import ast
import inspect
from routers import dashboard
from schemas import TopTopicsSummary


class TestTopicsNonblocking:
    def test_endpoint_probes_synthesizer_cache_directly(self):
        # Durable snapshots replace the process-local TTL cache. Reading them
        # must remain separate from model work.
        source = inspect.getsource(dashboard.get_dashboard_topics)
        assert "snapshots.read" in source
        tree = ast.parse(source)
        assert not any(isinstance(n, ast.Call) and
                       isinstance(n.func, ast.Name) and
                       n.func.id == "generate_feedback_summary" for n in ast.walk(tree))

    def test_endpoint_has_pending_and_ready_status_values(self):
        source = inspect.getsource(dashboard.get_dashboard_topics)
        assert '"ready"' in source and '"pending"' in source
        assert '"unsupported"' in source and '"error"' in source

    def test_endpoint_starts_background_thread(self):
        assert "_queue_topics(" in inspect.getsource(dashboard.get_dashboard_topics)
        assert "_TOPICS_EXECUTOR.submit(" in inspect.getsource(dashboard._queue_topics)
        assert dashboard._TOPICS_EXECUTOR._max_workers == 2

    def test_toptopicssummary_has_status_field_defaulting_to_ready(self):
        assert TopTopicsSummary(positive=[], negative=[], neutral=[]).status == "ready"
