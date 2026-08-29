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
