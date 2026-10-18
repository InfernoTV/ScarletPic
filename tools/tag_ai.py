"""Optional, resumable local WD14 tagging. Images are never uploaded.

Install: python -m pip install -r tools/requirements-ai.txt
Run:     python tools/tag_ai.py
Test:    python tools/tag_ai.py --limit 10
Downloads model.onnx and selected_tags.csv from the model's Hugging Face repo.
Outputs public/data/ai-tags.json. Redeploy public/ to publish the resulting tags,
or import that JSON through the site's Tags & tools menu to use it locally.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import json
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parent.parent


def write_json(path, data):
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',',':')), encoding='utf-8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--model', default='SmilingWolf/wd-swinv2-tagger-v3')
    parser.add_argument('--threshold', type=float, default=.35)
    parser.add_argument('--character-threshold', type=float, default=.85)
    parser.add_argument('--threads', type=int, default=min(8, os.cpu_count() or 4))
    parser.add_argument('--batch', type=int, default=4)
    parser.add_argument('--limit', type=int, default=0, help='Process only this many remaining images; 0 means all')
    parser.add_argument('--cache', type=Path, default=ROOT / '.models')
    args = parser.parse_args()
    if not 0 < args.threshold <= 1 or not 0 < args.character_threshold <= 1:
        parser.error('Thresholds must be greater than 0 and at most 1.')
    if args.batch < 1 or args.threads < 1 or args.limit < 0:
        parser.error('Batch and threads must be positive; limit must be non-negative.')
    try:
        import numpy as np
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise SystemExit(f'Missing AI dependency: {exc}. Run: python -m pip install -r tools/requirements-ai.txt')
    catalogue = json.loads((ROOT / 'public/data/catalogue.json').read_text(encoding='utf-8'))
    output = ROOT / 'public/data/ai-tags.json'
    data = json.loads(output.read_text(encoding='utf-8')) if output.exists() else {'model':None, 'images':{}}
    if data.get('model') and data['model'] != args.model:
        raise SystemExit('Existing tags came from another model. Back up and rename ai-tags.json first.')
    parameters = {'threshold':args.threshold,'character_threshold':args.character_threshold}
    if data.get('parameters') and data['parameters'] != parameters:
        raise SystemExit('Thresholds differ from existing tags. Back up and rename ai-tags.json to start again.')
    pending = [row for row in catalogue['images'] if row['id'] not in data.get('images',{})]
    if args.limit:
        pending = pending[:args.limit]
    if not pending:
        print('All requested images are already tagged.'); return
    print(f'Preparing {args.model}. This downloads the model on first use; inference stays on your computer.', flush=True)
    model_path = hf_hub_download(args.model, 'model.onnx', cache_dir=args.cache)
    csv_path = hf_hub_download(args.model, 'selected_tags.csv', cache_dir=args.cache)
    with open(csv_path, encoding='utf-8', newline='') as stream:
        labels = list(csv.DictReader(stream))
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model_path), sess_options=options, providers=['CPUExecutionProvider'])
    input_info = session.get_inputs()[0]
    shape = input_info.shape
    channels_last = shape[-1] == 3
    side = shape[1] if channels_last else shape[2]
    if not isinstance(side, int):
        side = 448
    fixed_batch = shape[0] if isinstance(shape[0], int) else None
    batch_size = fixed_batch or args.batch
    data.update({'model':args.model, 'parameters':parameters})
    data.setdefault('images',{})

    def preprocess(row):
        with Image.open(ROOT / 'public/media/images' / (row['id'] + '.webp')) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            # WD14 model-card preprocessing: centered white square, 448px, BGR,
            # float32 in the original 0..255 range (no CLIP normalization).
            square = Image.new('RGB', (max(image.size),max(image.size)), 'white')
            square.paste(image,((square.width-image.width)//2,(square.height-image.height)//2))
            square = square.resize((side,side), Image.Resampling.BICUBIC)
            array = np.asarray(square,dtype=np.float32)[:,:,::-1].copy()
            return array if channels_last else array.transpose(2,0,1)

    started = time.perf_counter(); processed = 0
    try:
        with ThreadPoolExecutor(max_workers=min(4,args.threads)) as pool:
            for offset in range(0,len(pending),batch_size):
                rows = pending[offset:offset+batch_size]
                images = list(pool.map(preprocess,rows))
                if fixed_batch:
                    images.extend([images[-1]]*(fixed_batch-len(images)))
                predictions = session.run(None,{input_info.name:np.stack(images)})[0]
                for row, probabilities in zip(rows,predictions):
                    tags = []
                    for label, probability in zip(labels,probabilities):
                        category = int(label['category'])
                        if category not in (0,4):
                            continue  # Do not publish rating labels as content tags.
                        threshold = args.character_threshold if category == 4 else args.threshold
                        if float(probability) >= threshold:
                            tags.append({'tag':label['name'], 'score':round(float(probability),4),
                                         'category':'character' if category==4 else 'general'})
                    tags.sort(key=lambda item:item['score'],reverse=True)
                    data['images'][row['id']] = tags
                processed += len(rows)
                if processed % 32 < batch_size or processed == len(pending):
                    write_json(output,data)
                    elapsed = max(.01,time.perf_counter()-started)
                    print(f'{processed:,}/{len(pending):,} tagged ({processed/elapsed:.2f} images/sec)',flush=True)
    except BaseException:
        write_json(output,data)
        raise
    write_json(output,data)
    print(f'Done. {output}\nRedeploy public/ or import this JSON through Tags & tools. Predictions can be wrong; review character tags.')


if __name__ == '__main__':
    main()
