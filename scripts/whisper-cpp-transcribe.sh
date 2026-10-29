#!/bin/bash
# This file deliberately uses plain [ ] / unbraced-$VAR style; some optional
# style rules would demand the other convention. Never let an autofix
# restyle it - see scripts/watchdog.sh's header for why.
# shellcheck disable=SC2250,SC2292
# Transcribe audio file using whisper.cpp (local, free, single native binary)
# Usage: whisper-cpp-transcribe.sh <audio_file_path>
# Outputs: transcription text to stdout
#
# Alternative to scripts/whisper-transcribe.sh (mlx-whisper): same contract,
# but no Python venv to maintain - just two Homebrew binaries and a model file.
#
# Setup (one-time):
#   brew install whisper-cpp ffmpeg
#   mkdir -p ~/.cache/whisper.cpp
#   curl -fL -o ~/.cache/whisper.cpp/ggml-large-v3-turbo.bin \
#     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
#   cp scripts/whisper-cpp-transcribe.sh ~/whisper-transcribe.sh
#   chmod +x ~/whisper-transcribe.sh
#
# The model is about 1.6 GB. Set WHISPER_MODEL to use a different ggml model
# file (for example a smaller one on a low-memory machine).
#
# The whatsapp-channel plugin invokes ~/whisper-transcribe.sh on every
# incoming voice/audio message. If the script is missing or fails, the
# message falls back to a non-transcribed attachment.
#
# Exit codes:
#   1  - general failure (bad usage, ffmpeg/whisper-cli error, empty transcript)
#   2  - whisper-cli, ffmpeg or the model file is missing (not set up)
#
# Contract: server.ts runs this script and treats stdout as the transcript
# verbatim, so stdout MUST stay exactly the transcript text, or empty on
# failure. Anything diagnostic goes to stderr only. whisper-cli is chatty
# (ggml/Metal init, timings) so its stdout is redirected to stderr and the
# transcript is read back from a temp file instead.

set -euo pipefail

# Homebrew's bin is not in PATH under launchd by default.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

MODEL="${WHISPER_MODEL:-$HOME/.cache/whisper.cpp/ggml-large-v3-turbo.bin}"

if [ $# -lt 1 ]; then
	echo "usage: whisper-cpp-transcribe.sh <audio_file_path>" >&2
	exit 1
fi

if ! command -v whisper-cli >/dev/null 2>&1; then
	echo "whisper-cpp-transcribe.sh: whisper-cli not found - run 'brew install whisper-cpp' (see setup instructions at the top of this script)" >&2
	exit 2
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
	echo "whisper-cpp-transcribe.sh: ffmpeg not found - run 'brew install ffmpeg' (see setup instructions at the top of this script)" >&2
	exit 2
fi
if [ ! -f "$MODEL" ]; then
	echo "whisper-cpp-transcribe.sh: model not found at $MODEL (see setup instructions at the top of this script)" >&2
	exit 2
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/whisper-cpp.XXXXXX")
WHISPER_PID=""
cleanup() {
	# execFile's timeout only signals this script, not its children; make sure
	# an orphaned whisper-cli does not keep burning the GPU.
	if [ -n "$WHISPER_PID" ]; then
		kill "$WHISPER_PID" 2>/dev/null || true
	fi
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT
# bash skips the EXIT trap when killed by an untrapped signal.
trap 'exit 143' TERM INT HUP

# whisper.cpp only reads 16 kHz mono 16-bit PCM WAV.
# ffmpeg exits with large codes (for example 187 on a non-audio file); the
# contract above documents 1 for every non-setup failure.
if ! ffmpeg -nostdin -hide_banner -loglevel error -y -i "$1" \
	-vn -ac 1 -ar 16000 -c:a pcm_s16le "$WORK_DIR/audio.wav" >&2; then
	echo "whisper-cpp-transcribe.sh: ffmpeg could not decode $1" >&2
	exit 1
fi

# Background + wait so the TERM trap above can fire while whisper-cli runs.
whisper-cli -m "$MODEL" -f "$WORK_DIR/audio.wav" -l auto -nt -np \
	-otxt -of "$WORK_DIR/transcript" >&2 &
WHISPER_PID=$!
if ! wait "$WHISPER_PID"; then
	WHISPER_PID=""
	echo "whisper-cpp-transcribe.sh: whisper-cli failed for $1" >&2
	exit 1
fi
WHISPER_PID=""

# One line: newlines to spaces, squeeze whitespace runs, trim both ends.
TRANSCRIPT=""
if [ -f "$WORK_DIR/transcript.txt" ]; then
	TRANSCRIPT=$(tr -s '[:space:]' ' ' <"$WORK_DIR/transcript.txt" | sed -e 's/^ //' -e 's/ $//')
fi

if [ -z "$TRANSCRIPT" ]; then
	echo "whisper-cpp-transcribe.sh: empty transcript for $1" >&2
	exit 1
fi

printf '%s\n' "$TRANSCRIPT"
