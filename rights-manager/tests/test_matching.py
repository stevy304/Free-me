"""The matching engine on real videos made with FFmpeg."""

import pytest

from app.services import matcher
from app.services.actions import match_status, with_watermark
from app.models import Policy
from app.workers.tasks import fingerprint_video


@pytest.fixture(scope="module")
def prints(videos):
    def fp(name, variants=True):
        f = fingerprint_video(videos[name], audio_variants=variants)
        return {"sha": f["sha"], "hashes": f["hashes"], "audio": f["audio"]}

    return {"original": fp("original", variants=False), **{k: fp(k) for k in ("copy", "hflip", "speed12", "other", "other2")}}


def test_same_file_uploaded_twice_scores_100(prints):
    s = matcher.compare(prints["copy"], prints["original"])
    assert s.exact and s.combined == 100.0
    assert match_status(s.combined, Policy.Block) == "blocked"


def test_mirrored_copy_scores_above_85(prints):
    s = matcher.compare(prints["hflip"], prints["original"])
    print("hflip", s)
    assert not s.exact
    assert s.combined > 85
    assert s.video > 85 and s.audio is not None and s.audio > 85


def test_copy_at_1_2x_speed_scores_above_70(prints):
    s = matcher.compare(prints["speed12"], prints["original"])
    print("speed 1.2x", s)
    assert s.combined > 70


@pytest.mark.parametrize("name", ["other", "other2"])
def test_unrelated_videos_are_approved(prints, name):
    s = matcher.compare(prints[name], prints["original"])
    print(name, s)
    assert s.combined < 50


def test_score_rules_and_watermark_bonus():
    assert match_status(85, Policy.Block) == "blocked"
    assert match_status(90, Policy.Mute) == "muted"
    assert match_status(90, Policy.Flag) == "flagged"
    assert match_status(90, Policy.Track) == "tracked"
    assert match_status(84.9, Policy.Block) == "flagged"
    assert match_status(70, Policy.Block) == "flagged"
    assert match_status(69.9, Policy.Block) == "approved"
    assert with_watermark(78, True) == 88 and with_watermark(95, True) == 100 and with_watermark(78, False) == 78


def test_video_only_when_one_side_has_no_sound():
    assert matcher.combine(80, None) == 80
    assert matcher.combine(80, 50) == 68
