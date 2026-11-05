"""API surface test: drive dashboard/plugin_api.py through FastAPI's TestClient.

Run with the Hermes runtime venv (it has fastapi): 
    ~/.hermes/installs/*/environments/*/venv/bin/python -m unittest tests.test_api
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - fastapi missing
    FastAPI = None
    TestClient = None


def load_api():
    spec = importlib.util.spec_from_file_location("wheelspin_api", ROOT / "dashboard" / "plugin_api.py")
    module = importlib.util.module_from_spec(spec)
    import sys

    sys.modules["wheelspin_api"] = module  # pydantic resolves model forward refs by module name
    spec.loader.exec_module(module)
    return module


@unittest.skipIf(TestClient is None, "fastapi not installed")
class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.api = load_api()
        self.patch = mock.patch.object(
            self.api.core, "plugin_data_dir", lambda name="wheelspin": Path(self.tmp.name)
        )
        self.patch.start()
        app = FastAPI()
        app.include_router(self.api.router, prefix="/api/plugins/wheelspin")
        self.client = TestClient(app)

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_health(self):
        self.assertEqual(self.client.get("/api/plugins/wheelspin/health").json()["ok"], True)

    def test_empty_then_load_then_spin(self):
        empty = self.client.get("/api/plugins/wheelspin/wheels").json()
        self.assertEqual(empty["wheels"], [])

        created = self.client.post(
            "/api/plugins/wheelspin/wheels",
            json={"name": "dinner", "items": ["pizza", "thai", "sushi"]},
        )
        self.assertEqual(created.status_code, 200, created.text)
        body = created.json()
        self.assertEqual(len(body["wheels"]), 1)
        self.assertEqual(body["wheels"][0]["id"], "dinner")

        spin = self.client.post("/api/plugins/wheelspin/wheels/dinner/spin", json={"count": 1})
        self.assertEqual(spin.status_code, 200, spin.text)
        winner = spin.json()["winners"][0]
        self.assertIn(winner["label"], {"pizza", "thai", "sushi"})
        self.assertIn(winner["index"], (0, 1, 2))

    def test_spin_unknown_wheel_is_404(self):
        response = self.client.post("/api/plugins/wheelspin/wheels/nope/spin", json={"count": 1})
        self.assertEqual(response.status_code, 404)

    def test_bad_payload_is_400(self):
        response = self.client.post("/api/plugins/wheelspin/wheels", json={"name": "x", "items": []})
        self.assertEqual(response.status_code, 400)

    def test_delete(self):
        self.client.post("/api/plugins/wheelspin/wheels", json={"name": "x", "items": ["a", "b"]})
        removed = self.client.delete("/api/plugins/wheelspin/wheels/x")
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["wheels"], [])

    def test_history_visible_after_spin(self):
        self.client.post("/api/plugins/wheelspin/wheels", json={"name": "d", "items": ["a", "b"]})
        self.client.post("/api/plugins/wheelspin/wheels/d/spin", json={"count": 2})
        state = self.client.get("/api/plugins/wheelspin/wheels").json()
        self.assertEqual(len(state["history"]), 2)

    def test_jackpot_indices_are_not_exposed(self):
        self.client.post(
            "/api/plugins/wheelspin/wheels",
            json={"name": "d", "items": ["a", "b", "c", "d", "e"]},
        )
        state = self.client.get("/api/plugins/wheelspin/wheels").json()
        self.assertNotIn("jackpots", state["wheels"][0])
        self.assertNotIn("jackpot", state["wheels"][0]["items"][0])

    def test_spin_reports_jackpot_flag(self):
        self.client.post(
            "/api/plugins/wheelspin/wheels",
            json={"name": "d", "items": ["a", "b", "c", "d", "e"]},
        )
        body = self.client.post("/api/plugins/wheelspin/wheels/d/spin", json={"count": 1}).json()
        self.assertIn("jackpot", body)
        self.assertIsInstance(body["jackpot"], bool)

    def test_append_mode_via_api(self):
        self.client.post("/api/plugins/wheelspin/wheels", json={"name": "d", "items": ["a", "b"]})
        self.client.post(
            "/api/plugins/wheelspin/wheels",
            json={"name": "d", "items": ["c"], "mode": "append"},
        )
        state = self.client.get("/api/plugins/wheelspin/wheels").json()
        labels = [item["label"] for item in state["wheels"][0]["items"]]
        self.assertEqual(labels, ["a", "b", "c"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
