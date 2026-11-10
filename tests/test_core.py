"""Tests for the wheelspin core, art and store. stdlib unittest, no deps."""

from __future__ import annotations

import json
import random
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import art  # noqa: E402
import core  # noqa: E402


class ItemsTest(unittest.TestCase):
    def test_accepts_plain_strings(self):
        self.assertEqual(
            core.normalise_items(["a", "b"]),
            [{"label": "a", "weight": 1}, {"label": "b", "weight": 1}],
        )

    def test_accepts_weighted_dicts(self):
        out = core.normalise_items([{"label": "a", "weight": 3}, "b"])
        self.assertEqual([i["weight"] for i in out], [3, 1])

    def test_collapses_duplicate_labels_case_insensitively(self):
        out = core.normalise_items(["Pizza", "pizza", "Thai"])
        self.assertEqual(out, [{"label": "Pizza", "weight": 2}, {"label": "Thai", "weight": 1}])

    def test_rejects_empty(self):
        with self.assertRaises(core.WheelError):
            core.normalise_items([])

    def test_rejects_blank_label(self):
        with self.assertRaises(core.WheelError):
            core.normalise_items(["   "])

    def test_clamps_weight(self):
        out = core.normalise_items([{"label": "x", "weight": 99999}])
        self.assertEqual(out[0]["weight"], core.MAX_WEIGHT)

    def test_rejects_non_positive_weight(self):
        with self.assertRaises(core.WheelError):
            core.normalise_items([{"label": "x", "weight": 0}])

    def test_strips_control_characters(self):
        out = core.normalise_items(["a\x00b\nc"])
        self.assertEqual(out[0]["label"], "a b c")

    def test_truncates_long_labels(self):
        out = core.normalise_items(["x" * 400])
        self.assertEqual(len(out[0]["label"]), core.MAX_LABEL_CHARS)

    def test_caps_item_count(self):
        with self.assertRaises(core.WheelError):
            core.normalise_items([f"item {i}" for i in range(core.MAX_ITEMS + 5)])


class DrawTest(unittest.TestCase):
    def test_weights_are_respected_statistically(self):
        items = core.normalise_items([{"label": "heavy", "weight": 9}, {"label": "light", "weight": 1}])
        rng = random.Random(1234)
        draws = [core.draw_index(items, rng) for _ in range(20000)]
        heavy = draws.count(0) / len(draws)
        self.assertGreater(heavy, 0.88)
        self.assertLess(heavy, 0.92)

    def test_never_returns_out_of_range(self):
        items = core.normalise_items(["a", "b", "c"])
        rng = random.Random(7)
        for _ in range(5000):
            self.assertIn(core.draw_index(items, rng), (0, 1, 2))

    def test_empty_wheel_raises(self):
        with self.assertRaises(core.WheelError):
            core.draw_index([])


class ArtTest(unittest.TestCase):
    def items(self, n=5):
        return core.normalise_items([{"label": f"opt{i}", "weight": i + 1} for i in range(n)])

    def test_bar_matches_requested_width(self):
        items = self.items()
        art_text = art.render_art(items, 2, width=40)
        row = [line for line in art_text.splitlines() if line.startswith("│")][0]
        self.assertEqual(len(row) - 2, 40)  # strip is exactly `width` cells

    def test_every_line_starts_at_column_zero(self):
        """Models re-type this text; leading whitespace is the first thing lost."""
        for line in art.render_art(self.items(), 1, jackpot=True).splitlines():
            if line:
                self.assertFalse(line.startswith(" "), repr(line))

    def test_pointer_present_when_winner_given(self):
        art_text = art.render_art(self.items(), 1)
        self.assertIn("▼", art_text)
        self.assertIn("★", art_text)

    def test_no_pointer_before_spin(self):
        art_text = art.render_art(self.items())
        self.assertNotIn("▼", art_text)

    def test_legend_shows_percentages(self):
        art_text = art.render_art(self.items(), 0)
        self.assertIn("%", art_text)

    def test_handles_more_items_than_cells(self):
        items = core.normalise_items([f"i{i}" for i in range(80)])
        art_text = art.render_art(items, 3, width=30)
        self.assertIn("… and", art_text)

    def test_allocation_sums_exactly(self):
        for weights in ([1, 1, 1], [5, 3, 2], [1] * 40, [97, 1, 1, 1]):
            cells = art._allocate(weights, 48)
            self.assertEqual(sum(cells), 48, weights)
            self.assertTrue(all(c >= 1 for c in cells), (weights, cells))


class JackpotTest(unittest.TestCase):
    def test_count_scales_with_wheel_size(self):
        self.assertEqual(core.jackpot_count(1), 0)
        self.assertEqual(core.jackpot_count(5), 1)
        self.assertEqual(core.jackpot_count(10), 2)
        self.assertEqual(core.jackpot_count(40), core.MAX_JACKPOTS)

    def test_picks_are_distinct_and_in_range(self):
        for size in (2, 5, 12, 30):
            picks = core.choose_jackpots(size)
            self.assertEqual(len(picks), len(set(picks)))
            self.assertTrue(all(0 <= index < size for index in picks))
            self.assertEqual(len(picks), core.jackpot_count(size))

    def test_jackpots_do_not_change_the_odds(self):
        items = core.normalise_items([{"label": "a", "weight": 3}, {"label": "b", "weight": 1}])
        rng = random.Random(99)
        draws = [core.draw_index(items, rng) for _ in range(20000)]
        self.assertAlmostEqual(draws.count(0) / len(draws), 0.75, delta=0.02)


class MagazineTest(unittest.TestCase):
    def test_splits_into_belts_of_eight(self):
        items = core.normalise_items([f"i{n}" for n in range(50)])
        belts = core.magazines(items)
        self.assertEqual(len(belts), 7)
        self.assertTrue(all(len(belt) <= core.MAX_SECTORS for belt in belts))
        self.assertEqual(sum(len(belt) for belt in belts), 50)

    def test_small_wheel_has_one_stage(self):
        items = core.normalise_items(["a", "b", "c"])
        draw = core.draw_hierarchical(items, random.Random(1))
        self.assertEqual(len(draw["path"]), 1)
        self.assertEqual(draw["depth"], 1)

    def test_big_wheel_feeds_through_belts(self):
        items = core.normalise_items([f"i{n}" for n in range(30)])
        draw = core.draw_hierarchical(items, random.Random(2))
        self.assertEqual(len(draw["path"]), 2)
        # stage one picks a belt, stage two picks inside that belt-load
        self.assertTrue(all(label.startswith("belt ") for label in draw["path"][0]["labels"]))
        self.assertTrue(all(label.startswith("i") for label in draw["path"][1]["labels"]))
        self.assertLessEqual(len(draw["path"][1]["labels"]), core.MAX_SECTORS)
        self.assertEqual(
            draw["path"][1]["labels"][draw["path"][1]["chosen"]], items[draw["index"]]["label"]
        )

    def test_deep_wheels_stay_under_eight_sectors_per_stage(self):
        items = core.normalise_items([f"i{n}" for n in range(1500)])
        draw = core.draw_hierarchical(items, random.Random(4))
        self.assertGreaterEqual(len(draw["path"]), 3)
        for stage in draw["path"]:
            self.assertLessEqual(len(stage["labels"]), core.MAX_SECTORS)
        self.assertEqual(
            draw["path"][-1]["labels"][draw["path"][-1]["chosen"]], items[draw["index"]]["label"]
        )

    def test_odds_match_one_flat_draw(self):
        """Magazine feeding must not distort the weights by even a fraction."""
        items = core.normalise_items(
            [{"label": f"i{n}", "weight": (n % 5) + 1} for n in range(50)]
        )
        rng = random.Random(11)
        counts = [0] * len(items)
        rounds = 40000
        for _ in range(rounds):
            counts[core.draw_hierarchical(items, rng)["index"]] += 1
        total = sum(item["weight"] for item in items)
        for index, item in enumerate(items):
            self.assertAlmostEqual(counts[index] / rounds, item["weight"] / total, delta=0.012)

    def test_weighted_belts_are_picked_proportionally(self):
        # One heavy item in belt 1 should pull belt 1 far more often than belt 2.
        items = core.normalise_items(
            [{"label": "whale", "weight": 900}] + [f"i{n}" for n in range(15)]
        )
        rng = random.Random(3)
        first_belt = sum(
            1 for _ in range(2000) if core.draw_hierarchical(items, rng)["path"][0]["chosen"] == 0
        )
        self.assertGreater(first_belt / 2000, 0.75)


class BadTimestampTest(unittest.TestCase):
    """A hand-edited or half-written timestamp must not raise out of read()."""

    def setUp(self):
        import tempfile
        self.root = Path(tempfile.mkdtemp()) / "wheelspin"

    def test_read_survives_a_non_numeric_timestamp(self):
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "wheels.json").write_text(
            json.dumps(
                {
                    "wheels": {
                        "broken": {
                            "id": "broken",
                            "name": "broken",
                            "items": [{"label": "one", "weight": 1}, {"label": "two", "weight": 1}],
                            "created_at": "yesterday",
                            "updated_at": None,
                        }
                    },
                    "active": "broken",
                    "history": [],
                    "order": ["broken"],
                }
            ),
            encoding="utf-8",
        )
        store = core.WheelStore(self.root)
        state = store.read()
        self.assertIn("broken", state["wheels"])
        wheel = store.get("broken")
        self.assertEqual(len(wheel["items"]), 2)
        self.assertGreater(wheel["created_at"], 0)


class ResultContractTest(unittest.TestCase):
    """`render_result` has no fallback any more, so prove the invariant holds."""

    def test_render_result_requires_a_path(self):
        with self.assertRaises(KeyError):
            art.render_result({"wheel": "w", "winners": [{"label": "a", "index": 0}]})

    def test_render_result_renders_when_the_path_is_present(self):
        spin = {
            "wheel": "w",
            "winners": [{"label": "a", "index": 0}],
            "path": [{"labels": ["a", "b"], "weights": [1, 1], "chosen": 0}],
            "belts": 1,
        }
        text = art.render_result(spin)
        self.assertIn("A", text)


class NonFiniteTimestampTest(unittest.TestCase):
    """NaN and Infinity are numbers to float(), and poison to JSON."""

    def test_non_finite_timestamps_are_rejected(self):
        for bad in ("nan", "inf", "-inf", "NaN", "Infinity"):
            self.assertEqual(core._as_float(bad, 7), 7, bad)
        self.assertEqual(core._as_float("1700000000", 7), 1700000000.0)

    def test_a_nan_timestamp_cannot_reach_the_file(self):
        root = Path(tempfile.mkdtemp()) / "wheelspin"
        root.mkdir(parents=True, exist_ok=True)
        (root / "wheels.json").write_text(
            json.dumps(
                {
                    "wheels": {
                        "w": {
                            "id": "w",
                            "name": "w",
                            "items": [{"label": "a", "weight": 1}],
                            "created_at": "nan",
                            "updated_at": "inf",
                        }
                    },
                    "active": "w",
                    "history": [],
                    "order": ["w"],
                }
            ),
            encoding="utf-8",
        )
        store = core.WheelStore(root)
        store.write(store.read())
        text = (root / "wheels.json").read_text()
        self.assertNotIn("NaN", text)
        self.assertNotIn("Infinity", text)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = core.WheelStore(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip(self):
        wheel = self.store.upsert("Dinner", ["pizza", "thai"])
        self.assertEqual(wheel["id"], "dinner")
        self.assertEqual(len(self.store.get()["items"]), 2)
        self.assertEqual(self.store.get()["name"], "Dinner")

    def test_persisted_json_is_readable(self):
        self.store.upsert("Dinner", ["pizza", "thai"])
        raw = json.loads((Path(self.tmp.name) / "wheels.json").read_text())
        self.assertEqual(raw["version"], 1)
        self.assertIn("dinner", raw["wheels"])

    def test_append_mode_adds_and_merges(self):
        self.store.upsert("d", ["a", "b"])
        self.store.upsert("d", ["b", "c"], mode="append")
        labels = [item["label"] for item in self.store.get("d")["items"]]
        self.assertEqual(labels, ["a", "b", "c"])
        self.assertEqual(self.store.get("d")["items"][1]["weight"], 2)

    def test_replace_mode_drops_old(self):
        self.store.upsert("d", ["a", "b", "c"])
        self.store.upsert("d", ["z"])
        self.assertEqual([i["label"] for i in self.store.get("d")["items"]], ["z"])

    def test_spin_records_history(self):
        self.store.upsert("d", ["a", "b"])
        result = self.store.spin("d", count=3)
        self.assertEqual(len(result["winners"]), 3)
        history = self.store.read()["history"]
        self.assertEqual(len(history), 3)
        self.assertEqual(history[-1]["wheel"], "d")

    def test_spin_probabilities_match_the_weights(self):
        self.store.upsert("d", [{"label": "a", "weight": 3}, {"label": "b", "weight": 1}])
        winner = self.store.spin("d")["winners"][0]
        self.assertEqual(winner["probability"], 0.75 if winner["label"] == "a" else 0.25)

    def test_delete_removes_and_moves_active(self):
        self.store.upsert("a", ["x", "y"])
        self.store.upsert("b", ["x", "y"])
        self.store.delete("b")
        self.assertEqual(self.store.read()["active"], "a")
        with self.assertRaises(core.WheelError):
            self.store.get("b")

    def test_unknown_wheel_lists_known_names(self):
        self.store.upsert("dinner", ["a", "b"])
        with self.assertRaises(core.WheelError) as ctx:
            self.store.get("lunch")
        self.assertIn("dinner", str(ctx.exception))

    def test_corrupt_file_is_quarantined_not_overwritten(self):
        self.store.upsert("dinner", ["pizza", "thai", "ramen"])
        path = Path(self.tmp.name) / "wheels.json"
        good = path.read_text()
        path.write_text(good[: len(good) // 2])

        # Reading reports an empty store, but only after the damage is preserved.
        self.assertEqual(self.store.summary()["wheels"], [])
        backups = sorted(Path(self.tmp.name).glob("wheels.json.corrupt-*"))
        self.assertEqual(len(backups), 1)
        self.assertIn("dinner", backups[0].read_text())

        # The next write must not be able to erase the user's only copy.
        self.store.upsert("drinks", ["beer", "wine"])
        self.assertEqual(
            [wheel["name"] for wheel in self.store.read()["wheels"].values()], ["drinks"]
        )
        self.assertEqual(len(sorted(Path(self.tmp.name).glob("wheels.json.corrupt-*"))), 1)

    def test_health_tells_an_empty_store_from_a_corrupt_one(self):
        self.assertEqual(
            self.store.health(),
            {"ok": True, "status": "ok", "wheels": 0, "corrupt_backups": 0},
        )
        (Path(self.tmp.name) / "wheels.json").write_text("{not json")
        report = self.store.health()
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "corrupt")
        self.assertEqual(report["corrupt_backups"], 1)
        self.assertNotIn(str(self.tmp.name), json.dumps(report))

    def test_health_stays_truthful_after_the_first_reader_quarantined(self):
        # N23: the pane's poll is usually the first reader, so `/health` must still
        # show that a store was moved aside rather than reporting a clean empty one.
        (Path(self.tmp.name) / "wheels.json").write_text("{not json")
        self.store.read()
        report = core.WheelStore(Path(self.tmp.name)).health()
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["corrupt_backups"], 1)

    def test_health_reports_an_unreadable_store_without_the_path(self):
        self.store.upsert("dinner", ["a", "b"])
        boom = PermissionError(13, "permission denied", str(self.store.path))
        with mock.patch.object(Path, "read_text", side_effect=boom):
            report = self.store.health()
        self.assertFalse(report["ok"])
        self.assertEqual(report["status"], "unreadable")
        self.assertNotIn(str(self.tmp.name), json.dumps(report))

    def test_history_is_capped(self):
        self.store.upsert("d", ["a", "b"])
        for _ in range(core.MAX_HISTORY // 10 + 2):
            self.store.spin("d", count=10)
        self.assertLessEqual(len(self.store.read()["history"]), core.MAX_HISTORY)

    def test_jackpots_survive_an_identical_reload(self):
        first = self.store.upsert("d", ["a", "b", "c", "d", "e"])
        second = self.store.upsert("d", ["a", "b", "c", "d", "e"])
        self.assertEqual(first["jackpots"], second["jackpots"])

    def test_jackpots_are_rechosen_when_options_change(self):
        self.store.upsert("d", ["a", "b", "c", "d", "e"])
        changed = self.store.upsert("d", ["a", "b", "c", "d", "z"])
        self.assertEqual(len(changed["jackpots"]), core.jackpot_count(5))

    def test_spin_flags_a_jackpot_winner(self):
        wheel = self.store.upsert("d", ["a", "b", "c", "d", "e"])
        jackpot_index = wheel["jackpots"][0]
        with mock.patch.object(core, "draw_index", return_value=jackpot_index):
            result = self.store.spin("d")
        self.assertTrue(result["jackpot"])
        self.assertTrue(result["winners"][0]["jackpot"])

    def test_spin_flags_a_plain_winner(self):
        wheel = self.store.upsert("d", ["a", "b", "c", "d", "e"])
        plain = next(i for i in range(5) if i not in wheel["jackpots"])
        with mock.patch.object(core, "draw_index", return_value=plain):
            result = self.store.spin("d")
        self.assertFalse(result["jackpot"])

    def test_slug_names(self):
        self.assertEqual(core.slugify("Next Game!!"), "next-game")
        self.assertEqual(core.slugify("  "), "wheel")

    def test_long_names_keep_distinct_keys(self):
        base = "a" * 55
        one, two = core.slugify(base + "one"), core.slugify(base + "two")
        self.assertNotEqual(one, two)
        self.assertLessEqual(len(one), 48)

    def test_long_named_wheels_do_not_overwrite_each_other(self):
        base = "a" * 55
        self.store.upsert(base + "one", ["x", "y"])
        self.store.upsert(base + "two", ["p", "q"])
        self.assertEqual(len(self.store.read()["wheels"]), 2)
        self.assertEqual(self.store.get(base + "two")["items"][0]["label"], "p")

    def test_a_legacy_truncated_key_is_reachable_by_display_name(self):
        name = "b" * 55 + "tail"
        legacy_id = "b" * 48
        state = {
            "version": 1,
            "active": legacy_id,
            "history": [],
            "wheels": {
                legacy_id: {
                    "id": legacy_id,
                    "name": name,
                    "items": [{"label": "x", "weight": 1}, {"label": "y", "weight": 1}],
                    "jackpots": [0],
                    "source": "",
                    "created_at": 1.0,
                    "updated_at": 1.0,
                }
            },
        }
        (Path(self.tmp.name) / "wheels.json").write_text(json.dumps(state))
        self.assertEqual(self.store.get(name)["id"], legacy_id)
        self.assertEqual(self.store.delete(name)["id"], legacy_id)

    def test_empty_jackpot_list_is_rerolled(self):
        state = {
            "version": 1,
            "active": "d",
            "history": [],
            "wheels": {
                "d": {
                    "id": "d",
                    "name": "d",
                    "items": [{"label": label, "weight": 1} for label in "abcde"],
                    "jackpots": [],
                    "source": "",
                    "created_at": 1.0,
                    "updated_at": 1.0,
                }
            },
        }
        (Path(self.tmp.name) / "wheels.json").write_text(json.dumps(state))
        self.assertGreaterEqual(len(self.store.get("d")["jackpots"]), 1)


class SemanticCorruptionTest(unittest.TestCase):
    """N21: a stored wheel with a bad field must not raise, and must not vanish."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = core.WheelStore(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self, wheel):
        state = {
            "version": 1,
            "active": "a",
            "history": [],
            "wheels": {
                "a": {
                    "id": "a",
                    "name": "a",
                    "items": [{"label": "x", "weight": 1}, {"label": "y", "weight": 1}],
                    "jackpots": [0],
                    "source": "",
                    "created_at": 1.0,
                    "updated_at": 1.0,
                },
                "b": wheel,
            },
        }
        (self.store.root / "wheels.json").write_text(json.dumps(state))

    def test_non_string_name_does_not_raise(self):
        self.store.root.mkdir(parents=True, exist_ok=True)
        (self.store.path).write_text(
            '{"version":1,"active":"b","history":[],"wheels":'
            '{"b":{"id":"b","name":123,"items":[{"label":"p","weight":1},{"label":"q","weight":1}],"jackpots":[0],"source":"","created_at":1,"updated_at":1}}}'
        )
        wheels = self.store.read()["wheels"]
        self.assertIn("b", wheels)
        self.assertEqual(wheels["b"]["name"], "b")

    def test_nan_jackpot_does_not_raise(self):
        self.store.root.mkdir(parents=True, exist_ok=True)
        (self.store.path).write_text(
            '{"version":1,"active":"b","history":[],"wheels":'
            '{"b":{"id":"b","name":"b","items":[{"label":"p","weight":1},{"label":"q","weight":1}],"jackpots":[NaN],"source":"","created_at":1,"updated_at":1}}}'
        )
        wheel = self.store.read()["wheels"]["b"]
        self.assertGreaterEqual(len(wheel["jackpots"]), 1)
        self.assertTrue(all(isinstance(i, int) for i in wheel["jackpots"]))

    def test_a_wheel_with_bad_items_is_preserved_not_erased(self):
        self._seed(
            {
                "id": "b",
                "name": "b",
                "items": [{"label": "keep", "weight": 1}, {"weight": 5}, 17, {"label": ""}],
                "jackpots": [0],
                "source": "",
                "created_at": 1.0,
                "updated_at": 1.0,
            }
        )
        self.assertEqual([i["label"] for i in self.store.read()["wheels"]["b"]["items"]], ["keep"])
        self.store.upsert("c", ["z", "w"])
        stored = json.loads(self.store.path.read_text())
        self.assertIn("b", stored["wheels"], "the next write must not erase a preserved wheel")


class DrawEdgeTest(unittest.TestCase):
    def test_per_one_does_not_recurse(self):
        # N24: magazines clamps per to 2, but the recursion guard compared against
        # the raw value and never terminated.
        result = core.draw_hierarchical(core.normalise_items(["a", "b"]), per=1)
        self.assertIn(result["index"], (0, 1))

    def test_a_bad_count_falls_back_to_one_draw(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = core.WheelStore(Path(tmp))
            store.upsert("d", ["a", "b"])
            self.assertEqual(len(store.spin("d", count="abc")["winners"]), 1)  # type: ignore[arg-type]


class LegacyKeyTest(unittest.TestCase):
    def test_reloading_a_legacy_long_name_adopts_its_key(self):
        # N26: get/delete found the old key by display name, upsert did not, so a
        # re-load created a second wheel beside the first.
        name = "b" * 55 + "tail"
        legacy = "b" * 48
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wheels.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "active": legacy,
                        "history": [],
                        "wheels": {
                            legacy: {
                                "id": legacy,
                                "name": name,
                                "items": [{"label": "x", "weight": 1}, {"label": "y", "weight": 1}],
                                "jackpots": [0],
                                "source": "",
                                "created_at": 1.0,
                                "updated_at": 1.0,
                            }
                        },
                    }
                )
            )
            store = core.WheelStore(Path(tmp))
            self.assertEqual(store.upsert(name, ["x", "y"])["id"], legacy)
            self.assertEqual(sorted(store.read()["wheels"]), [legacy])


class JackpotTests(unittest.TestCase):
    def test_a_jackpot_on_any_draw_sets_the_flag(self):
        # N27: the flag only reflected winners[0], so a jackpot on draw 2 was lost.
        with tempfile.TemporaryDirectory() as tmp:
            store = core.WheelStore(Path(tmp))
            wheel = store.upsert("d", ["a", "b", "c", "d", "e"])
            plain = next(i for i in range(5) if i not in wheel["jackpots"])
            order = [plain, wheel["jackpots"][0]]
            with mock.patch.object(core, "draw_index", side_effect=order * 5):
                self.assertTrue(store.spin("d", count=2)["jackpot"])

    def test_a_multi_draw_jackpot_keeps_the_headline(self):
        spin = {
            "wheel": "w",
            "winners": [{"label": "one"}, {"label": "two"}],
            "jackpot": True,
            "belts": 1,
            "path": [{"kind": "items", "labels": ["a", "b", "c"], "weights": [1, 1, 1], "chosen": 0}],
        }
        self.assertIn("JACKPOT!!!", art.render_result(spin).splitlines()[-1])

class QuarantineRaceTest(unittest.TestCase):
    """N22: a late reader must not quarantine a store a writer just replaced."""

    def test_late_quarantine_leaves_a_fresh_store_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "wheels.json"
            path.write_text("{not json")
            store = core.WheelStore(root)

            # The writer wins the race: the bad bytes are replaced by a good store
            # before the reader gets the lock.
            good = {
                "version": 1,
                "active": "dinner",
                "history": [],
                "wheels": {
                    "dinner": {
                        "id": "dinner",
                        "name": "dinner",
                        "items": [{"label": "a", "weight": 1}, {"label": "b", "weight": 1}],
                        "jackpots": [0],
                        "source": "",
                        "created_at": 1.0,
                        "updated_at": 1.0,
                    }
                },
            }
            path.write_text(json.dumps(good))

            store._quarantine()  # the reader's late rename

            self.assertTrue(path.exists(), "the fresh store must survive")
            self.assertEqual(list(root.glob("wheels.json.corrupt-*")), [])
            self.assertIn("dinner", store.read()["wheels"])

    def test_quarantine_still_moves_bytes_that_are_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wheels.json"
            path.write_text("{not json")
            core.WheelStore(Path(tmp)).read()
            self.assertFalse(path.exists())
            self.assertEqual(len(list(Path(tmp).glob("wheels.json.corrupt-*"))), 1)


class OverflowTest(unittest.TestCase):
    """N29: Overflows are a read-path escape the N21 coercers did not catch."""

    def test_stored_numbers_that_overflow_do_not_raise(self):
        huge = "9" * 401
        raw = (
            '{"version":1,"active":"b","history":[],"wheels":{"b":{"id":"b","name":"b",'
            '"items":[{"label":"p","weight":1e400},{"label":"q","weight":1}],'
            '"jackpots":[' + huge + '],"source":"","created_at":' + huge + ',"updated_at":1}}}'
        )
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "wheels.json").write_text(raw)
            wheel = core.WheelStore(Path(tmp)).read()["wheels"]["b"]
            self.assertEqual([i["weight"] for i in wheel["items"]], [1, 1])
            self.assertGreaterEqual(len(wheel["jackpots"]), 1)
            self.assertTrue(all(isinstance(i, int) for i in wheel["jackpots"]))

    def test_input_weight_of_infinity_is_a_wheel_error(self):
        with self.assertRaises(core.WheelError):
            core.normalise_items([{"label": "a", "weight": float("inf")}])

    def test_a_bad_count_of_infinity_falls_back_to_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = core.WheelStore(Path(tmp))
            store.upsert("d", ["a", "b"])
            self.assertEqual(len(store.spin("d", count=float("inf"))["winners"]), 1)

    def test_a_huge_weight_is_clamped_not_dropped(self):
        items = core._salvage_items([{"label": "a", "weight": 10**400}, {"label": "b", "weight": 1}])
        self.assertEqual([i["label"] for i in items], ["a", "b"])
        self.assertEqual([i["weight"] for i in items], [core.MAX_WEIGHT, 1])


class RenderResultTest(unittest.TestCase):
    def test_a_result_with_no_winners_is_a_bug_not_a_blank_banner(self):
        spin = {
            "wheel": "w",
            "winners": [],
            "jackpot": False,
            "path": [{"kind": "items", "labels": ["a"], "weights": [1], "chosen": 0}],
        }
        with self.assertRaises(KeyError):
            art.render_result(spin)

    def test_the_picture_matches_the_draw_the_jackpot_banner_is_about(self):
        # N27 tail: the banner is any-draw, but the art always drew draw 1's path.
        spin = {
            "wheel": "w",
            "winners": [
                {"label": "first", "jackpot": False},
                {"label": "second", "jackpot": True},
            ],
            "jackpot": True,
            "path": [{"kind": "items", "labels": ["first", "x"], "weights": [1, 1], "chosen": 0}],
            "paths": [
                [{"kind": "items", "labels": ["first", "x"], "weights": [1, 1], "chosen": 0}],
                [{"kind": "items", "labels": ["second", "y"], "weights": [1, 1], "chosen": 0}],
            ],
            "belts": 1,
        }
        text = art.render_result(spin)
        self.assertIn("SECOND", text)
        self.assertIn("JACKPOT!!!", text.splitlines()[-1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
