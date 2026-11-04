"""Local transcription worker. Only opens the verified checkpoint provided by the host."""
import json
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import torch
import whisper


def transcribe(config):
    torch.set_num_threads(max(1, min(6, os.cpu_count() or 2)))
    model = whisper.load_model(config['model'], device='cpu')
    directory = Path(config['directory'])
    language = None if config['language'] == 'auto' else config['language']
    for part in config['parts']:
        output = directory / f"{part['index']:06d}.json"
        if output.is_file():
            continue
        start, end = part['start'], part['end']
        pcm = subprocess.run(
            [config['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-nostdin',
             '-ss', str(start), '-i', config['audio'], '-t', str(end - start),
             '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ).stdout
        samples = np.frombuffer(pcm, dtype=np.float32).copy()
        if samples.size:
            result = model.transcribe(samples, language=language, fp16=False,
                                      temperature=0, condition_on_previous_text=False,
                                      verbose=None)
            segments = []
            for segment in result.get('segments', []):
                text = str(segment.get('text', '')).strip()
                if text:
                    segments.append({'start': round(min(end, start + segment['start']), 3),
                                     'end': round(min(end, start + segment['end']), 3),
                                     'text': text})
            record = {**part, 'text': str(result.get('text', '')).strip(),
                      'language': result.get('language'), 'segments': segments}
        else:
            record = {**part, 'text': '', 'language': language, 'segments': []}
        temporary = output.with_suffix('.tmp')
        with temporary.open('w', encoding='utf-8') as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as stream:
        transcribe(json.load(stream))
