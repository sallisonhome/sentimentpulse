import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

spec = importlib.util.spec_from_file_location(
    "health", Path(__file__).with_name("steam_session_health.py")
)
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)
TOKEN = "test-only-ops-credential-1234567890"
WHEN = "2026-09-27T12:00:00.000Z"


class HealthTests(unittest.TestCase):
    def test_unquoted_quoted_export_and_comments(self):
        for assignment in [
            f"INGESTION_OPS_TOKEN={TOKEN}",
            f'INGESTION_OPS_TOKEN="{TOKEN}"',
            f"export INGESTION_OPS_TOKEN='{TOKEN}' # comment",
        ]:
            self.assertEqual(health.load_token("UNRELATED=ignored\n" + assignment), TOKEN)

    def test_missing_duplicate_empty_and_shell_interpolation_rejected(self):
        for text in [
            "", "INGESTION_OPS_TOKEN=", "INGESTION_OPS_TOKEN=''",
            "INGESTION_OPS_TOKEN=$(echo danger)",
            f"INGESTION_OPS_TOKEN={TOKEN}\nINGESTION_OPS_TOKEN={TOKEN}",
            'INGESTION_OPS_TOKEN="bad\\nvalue"',
        ]:
            with self.assertRaises(ValueError):
                health.load_token(text)

    def test_healthy_and_non_error_results(self):
        for result in ["success", "pending", "", None, "Error uppercase does not match"]:
            out = health.summarize(
                {"autoRefreshLastAttemptAt": WHEN, "autoRefreshLastResult": result}, TOKEN
            )
            self.assertEqual(out["status"], "healthy")

    def test_missing_attempt_is_not_a_failure_even_with_error_result(self):
        for payload in [{}, {"configured": False}, {
            "autoRefreshLastAttemptAt": None, "autoRefreshLastResult": "error: old",
        }]:
            self.assertEqual(health.summarize(payload, TOKEN)["status"], "no_attempt")

    def test_failed_refresh_is_distinct_from_failed_check(self):
        out = health.summarize({
            "autoRefreshLastAttemptAt": WHEN,
            "autoRefreshLastResult": "error: Steam rejected the refresh",
        }, TOKEN)
        self.assertEqual(out["status"], "refresh_failed")
        self.assertIn("Steam rejected the refresh", out["autoRefreshLastResult"])

    def test_extra_cookie_and_identity_fields_never_returned(self):
        out = health.summarize({
            "autoRefreshLastAttemptAt": WHEN, "autoRefreshLastResult": "success",
            "cookiePreview": "SECRET", "loggedInAs": "PRIVATE", "refreshTokenValue": "SECRET",
        }, TOKEN)
        self.assertEqual(set(out), {
            "status", "autoRefreshLastAttemptAt", "autoRefreshLastResult",
        })
        self.assertNotIn("SECRET", json.dumps(out))

    def test_secrets_in_errors_redacted(self):
        messages = [
            "error: token=" + TOKEN,
            "error: steamRefresh_partner=abc; timeout",
            "error: https://steam.example/login?token=secret",
            "error: Cookie: session=topsecret",
            "error: x-ops-token: anothersecret",
            "error: A" + "b" * 40,
            "error: Authorization: Bearer secret",
        ]
        for message in messages:
            out = health.redact(message, TOKEN)
            self.assertTrue(out.startswith("error"))
            self.assertIn("REDACTED", out)
            self.assertNotIn(TOKEN, out)
            self.assertNotIn("topsecret", out)

    def test_invalid_contracts_not_healthy(self):
        for payload in [
            [], {"autoRefreshLastAttemptAt": 123},
            {"autoRefreshLastAttemptAt": ""},
            {"autoRefreshLastAttemptAt": "2026-09-27"},
            {"autoRefreshLastAttemptAt": WHEN, "autoRefreshLastResult": {}},
        ]:
            with self.assertRaises(ValueError):
                health.summarize(payload, TOKEN)

    def test_exact_get_loopback_target_and_timeout(self):
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = json.dumps({
            "autoRefreshLastAttemptAt": WHEN, "autoRefreshLastResult": "success",
        }).encode()
        self.assertEqual(health.probe(TOKEN, opener)["status"], "healthy")
        args, kwargs = opener.open.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:5000/api/steam/session")
        self.assertEqual(args[0].get_method(), "GET")
        self.assertEqual(args[0].get_header("X-ops-token"), TOKEN)
        self.assertEqual(kwargs, {"timeout": 15})
        response.read.assert_called_once_with(health.MAX_BYTES + 1)

    def test_size_ceiling(self):
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b"x" * (health.MAX_BYTES + 1)
        with self.assertRaises(ValueError):
            health.probe(TOKEN, opener)

    def test_redirects_refused(self):
        self.assertIsNone(health.NoRedirect().redirect_request(
            None, None, 302, "", {}, "https://untrusted.example"
        ))

    def test_proxy_environment_not_used(self):
        with patch.object(health.urllib.request, "ProxyHandler", return_value="no-proxy") as proxy:
            with patch.object(health.urllib.request, "build_opener") as build:
                build.return_value.open.side_effect = OSError("network down")
                with self.assertRaises(OSError):
                    health.probe(TOKEN)
                proxy.assert_called_once_with({})

    def test_main_check_failures_are_safe_and_nonzero(self):
        for error in [
            urllib.error.HTTPError(health.ENDPOINT, 401, TOKEN, {}, None),
            urllib.error.URLError(TOKEN), ValueError(TOKEN), RuntimeError(TOKEN),
        ]:
            with patch.object(health.ENV_PATH.__class__, "read_text", return_value=f"INGESTION_OPS_TOKEN={TOKEN}"):
                with patch.object(health, "probe", side_effect=error):
                    stdout = io.StringIO()
                    with contextlib.redirect_stdout(stdout):
                        self.assertEqual(health.main(), 1)
                    out = json.loads(stdout.getvalue())
                    self.assertEqual(out["status"], "check_failed")
                    self.assertNotIn(TOKEN, stdout.getvalue())

    def test_main_failed_refresh_retrieval_succeeds(self):
        with patch.object(health.ENV_PATH.__class__, "read_text", return_value=f"INGESTION_OPS_TOKEN={TOKEN}"):
            with patch.object(health, "probe", return_value={
                "status": "refresh_failed", "autoRefreshLastAttemptAt": WHEN,
                "autoRefreshLastResult": "error: rejected",
            }):
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    self.assertEqual(health.main(), 0)
                self.assertEqual(json.loads(stdout.getvalue())["status"], "refresh_failed")

    def test_missing_file_emits_safe_failure(self):
        with patch.object(health.ENV_PATH.__class__, "read_text", side_effect=FileNotFoundError(TOKEN)):
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                self.assertEqual(health.main(), 1)
            self.assertNotIn(TOKEN, stdout.getvalue())
            self.assertEqual(json.loads(stdout.getvalue())["status"], "check_failed")


if __name__ == "__main__":
    unittest.main()
