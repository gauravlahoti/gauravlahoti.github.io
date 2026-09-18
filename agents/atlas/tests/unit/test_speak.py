"""Unit tests for the spoken-replies helper (spec #49).

Covers the two things that are pure functions and easy to get subtly wrong:
the RIFF header (a bad one plays as silence or noise, with no error) and
speech sanitization (a missed URL is read out character by character).
"""

from __future__ import annotations

import struct

from app.app_utils import speak


class TestWavHeader:
    def test_is_44_bytes(self) -> None:
        assert len(speak.wav_header(1000)) == 44

    def test_riff_and_wave_magic(self) -> None:
        header = speak.wav_header(1000)
        assert header[0:4] == b"RIFF"
        assert header[8:12] == b"WAVE"
        assert header[12:16] == b"fmt "
        assert header[36:40] == b"data"

    def test_chunk_sizes_track_payload(self) -> None:
        header = speak.wav_header(2048)
        assert struct.unpack("<I", header[4:8])[0] == 36 + 2048
        assert struct.unpack("<I", header[40:44])[0] == 2048

    def test_pcm_format_fields(self) -> None:
        header = speak.wav_header(10, sample_rate=24000)
        assert struct.unpack("<H", header[20:22])[0] == 1      # PCM
        assert struct.unpack("<H", header[22:24])[0] == 1      # mono
        assert struct.unpack("<I", header[24:28])[0] == 24000  # sample rate
        assert struct.unpack("<I", header[28:32])[0] == 48000  # byte rate
        assert struct.unpack("<H", header[32:34])[0] == 2      # block align
        assert struct.unpack("<H", header[34:36])[0] == 16     # bits/sample

    def test_pcm_to_wav_prepends_and_preserves(self) -> None:
        pcm = b"\x01\x02" * 100
        wav = speak.pcm_to_wav(pcm)
        assert len(wav) == 44 + len(pcm)
        assert wav[44:] == pcm


class TestSampleRateFromMime:
    def test_parses_documented_shape(self) -> None:
        assert speak._sample_rate_from_mime("audio/L16;codec=pcm;rate=24000") == 24000

    def test_parses_alternate_rate(self) -> None:
        assert speak._sample_rate_from_mime("audio/L16;codec=pcm;rate=16000") == 16000

    def test_falls_back_when_absent(self) -> None:
        assert speak._sample_rate_from_mime("audio/L16") == speak.DEFAULT_SAMPLE_RATE
        assert speak._sample_rate_from_mime("") == speak.DEFAULT_SAMPLE_RATE

    def test_rejects_implausible_rate(self) -> None:
        # A garbage rate would otherwise play back at the wrong speed.
        assert speak._sample_rate_from_mime("rate=999999") == speak.DEFAULT_SAMPLE_RATE


class TestSanitizeForSpeech:
    def test_strips_bare_urls(self) -> None:
        out = speak.sanitize_for_speech("See https://gauravlahoti.dev/resume.pdf for more")
        assert "http" not in out
        assert "See" in out and "for more" in out

    def test_keeps_markdown_link_text_drops_target(self) -> None:
        out = speak.sanitize_for_speech("Read [the spec](https://example.com/spec)")
        assert "the spec" in out
        assert "example.com" not in out

    def test_strips_citation_markers(self) -> None:
        out = speak.sanitize_for_speech("He led that migration [1] at Deloitte [12].")
        assert "[1]" not in out and "[12]" not in out
        assert "Deloitte" in out

    def test_strips_meta_block(self) -> None:
        out = speak.sanitize_for_speech(
            "Here you go. [[META]]{\"cta\":\"resume\"}[[/META]] Anything else?"
        )
        assert "META" not in out
        assert "Here you go." in out and "Anything else?" in out

    def test_strips_emphasis_but_keeps_words(self) -> None:
        out = speak.sanitize_for_speech("That was **eight years** of _cloud_ work")
        assert "*" not in out and "_" not in out
        assert "eight years" in out and "cloud" in out

    def test_strips_headings_and_bullets(self) -> None:
        out = speak.sanitize_for_speech("## Roles\n- Deloitte\n- Infosys")
        assert "#" not in out and not out.lstrip().startswith("-")
        assert "Deloitte" in out and "Infosys" in out

    def test_strips_code_fences_and_inline_code(self) -> None:
        out = speak.sanitize_for_speech("Run ```make corpus``` then `deploy` it")
        assert "`" not in out
        assert "deploy" in out

    def test_empty_and_whitespace_are_empty(self) -> None:
        assert speak.sanitize_for_speech("") == ""
        assert speak.sanitize_for_speech("   \n  ") == ""

    def test_url_only_text_sanitizes_to_empty(self) -> None:
        # speak_text() maps this to None rather than calling the model.
        assert speak.sanitize_for_speech("https://example.com") == ""

    def test_ordinary_prose_survives_intact(self) -> None:
        text = "He spent eight years at Deloitte, mostly on cloud migrations."
        assert speak.sanitize_for_speech(text) == text


class TestExtractAudio:
    def test_reads_inline_data_camel_case(self) -> None:
        payload = {
            "candidates": [
                {"content": {"parts": [
                    {"inlineData": {"mimeType": "audio/L16;rate=24000", "data": "AAEC"}}
                ]}}
            ]
        }
        pcm, rate = speak._extract_audio(payload)
        assert pcm == b"\x00\x01\x02"
        assert rate == 24000

    def test_reads_inline_data_snake_case(self) -> None:
        payload = {
            "candidates": [
                {"content": {"parts": [{"inline_data": {"data": "AAEC"}}]}}
            ]
        }
        pcm, _ = speak._extract_audio(payload)
        assert pcm == b"\x00\x01\x02"

    def test_skips_text_parts_to_find_audio(self) -> None:
        payload = {
            "candidates": [
                {"content": {"parts": [
                    {"text": "here you go"},
                    {"inlineData": {"data": "AAEC"}},
                ]}}
            ]
        }
        pcm, _ = speak._extract_audio(payload)
        assert pcm == b"\x00\x01\x02"

    def test_empty_payload_returns_no_audio(self) -> None:
        assert speak._extract_audio({})[0] == b""
        assert speak._extract_audio({"candidates": []})[0] == b""


class TestNormalizeEdges:
    """Edge silence is the seam problem (spec #62).

    A reply is several independently-synthesized clips butted together
    sample-accurately in the browser. Sample-accurate is not silence-accurate:
    each clip arrives with whatever lead-in and tail the model emitted, and
    those stack up into audible dead air at every seam — worse the longer the
    reply, because a long reply has more seams.
    """

    @staticmethod
    def _tone(samples: int, amplitude: int = 8000) -> bytes:
        # Alternating polarity so it is unambiguously above the noise floor
        # in both directions, which is what the scanners test.
        out = bytearray()
        for i in range(samples):
            value = amplitude if i % 2 == 0 else -amplitude
            out += value.to_bytes(2, "little", signed=True)
        return bytes(out)

    @staticmethod
    def _silence(samples: int) -> bytes:
        return b"\x00\x00" * samples

    def _pause_bytes(self, rate: int = speak.DEFAULT_SAMPLE_RATE) -> int:
        return (rate * speak.SEAM_PAUSE_MS // 1000) * speak.SAMPLE_WIDTH_BYTES

    def _guard_bytes(self, rate: int = speak.DEFAULT_SAMPLE_RATE) -> int:
        return (rate * speak.LEAD_GUARD_MS // 1000) * speak.SAMPLE_WIDTH_BYTES

    def test_strips_leading_silence_down_to_the_guard(self) -> None:
        pcm = self._silence(12000) + self._tone(2400)
        out = speak.normalize_edges(pcm)
        # Everything before the first audible sample goes except LEAD_GUARD_MS.
        assert len(out) == self._guard_bytes() + 2400 * 2 + self._pause_bytes()

    def test_keeps_a_guard_so_the_attack_is_not_clipped(self) -> None:
        # Cutting flush to the first sample above the floor shaves the onset of
        # a plosive and the word starts mid-consonant.
        pcm = self._silence(12000) + self._tone(2400)
        out = speak.normalize_edges(pcm)
        assert out[: self._guard_bytes()] == b"\x00" * self._guard_bytes()

    def test_normalizes_trailing_silence_to_a_fixed_pause(self) -> None:
        long_tail = speak.normalize_edges(self._tone(2400) + self._silence(24000))
        short_tail = speak.normalize_edges(self._tone(2400) + self._silence(120))
        # Both end up the same length: the model's tail is replaced, not
        # trimmed to nothing. Chunks break at sentence boundaries, where a
        # speaker would pause anyway, so removing the pause sounds hurried.
        assert len(long_tail) == len(short_tail)
        assert len(long_tail) == 2400 * 2 + self._pause_bytes()
        assert long_tail[-self._pause_bytes():] == b"\x00" * self._pause_bytes()

    def test_low_level_noise_counts_as_silence(self) -> None:
        # Model "silence" carries a noise floor; a bare `== 0` test finds
        # nothing to trim and the whole thing is a no-op in production.
        noise = b"".join(
            (40 if i % 2 else -40).to_bytes(2, "little", signed=True)
            for i in range(6000)
        )
        out = speak.normalize_edges(noise + self._tone(2400))
        assert len(out) < len(noise + self._tone(2400))

    def test_audio_above_the_floor_is_never_cut(self) -> None:
        body = self._tone(2400)
        out = speak.normalize_edges(body)
        assert out.startswith(body)

    def test_entirely_silent_clip_is_returned_unchanged(self) -> None:
        # Nothing audible means no edges to find. Guessing here would emit a
        # buffer of the wrong length for the text that produced it.
        pcm = self._silence(4800)
        assert speak.normalize_edges(pcm) == pcm

    def test_empty_and_truncated_input_do_not_raise(self) -> None:
        assert speak.normalize_edges(b"") == b""
        assert speak.normalize_edges(b"\x01") == b"\x01"

    def test_pause_length_follows_the_sample_rate(self) -> None:
        out = speak.normalize_edges(self._tone(1000), sample_rate=16000)
        assert out[-self._pause_bytes(16000):] == b"\x00" * self._pause_bytes(16000)

    def test_output_stays_sample_aligned(self) -> None:
        # An odd-length buffer would shift every subsequent sample by a byte
        # and play as noise.
        for pad in (0, 1, 7, 33):
            pcm = self._silence(pad) + self._tone(500) + self._silence(pad)
            assert len(speak.normalize_edges(pcm)) % speak.SAMPLE_WIDTH_BYTES == 0
