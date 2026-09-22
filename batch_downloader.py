import os
import re
import sys
import time
import subprocess
import requests
import imageio_ffmpeg
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT_DIR = r"C:\Users\Stefany\Downloads\2 uploud"
GERAL_DIR = r"C:\Users\Stefany\Downloads\2 uploud\geral"

os.makedirs(ROOT_DIR, exist_ok=True)
os.makedirs(GERAL_DIR, exist_ok=True)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

ROOT_URLS = [
    "https://www.wallpaperengine.space/wallpaper/ganyu-quiet-room-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/shenhe-starlit-ocean-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/capitano-on-the-throne-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/yelan-in-a-dark-crystal-portrait-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/kamisato-ayaka-by-an-open-door-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/noelle-in-a-sword-sequence-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/xilonen-resting-in-a-sunlit-interior-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/shenhe-koi-pond-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/ganyu-paper-room-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/yae-miko-among-petals",
    "https://www.wallpaperengine.space/wallpaper/arlecchino-red-scythe-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/furina-flower-sea-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/sangonomiya-kokomi-shimmering-portrait-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/furina-in-a-flooded-stone-city-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/xiao-in-a-painted-flame-portrait-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/furina-playing-piano-alone-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/skirk-in-a-blue-energy-chamber-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/furina-walking-through-a-rainy-city-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/columbina-in-a-blue-floral-scene-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/pathway-to-temple-of-space-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/genshin-impact-furina-sakura",
    "https://www.wallpaperengine.space/wallpaper/zephyrs-hymn-venti-dvalin-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/dawns-first-brew-hu-tao-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/midday-archway-vigil-fischl-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/oceans-sovereign-furina-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/cryo-aurora-ballet-eula-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/sweet-ember-snack-hu-tao-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/eternal-vigil-raiden-shogun-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/misty-reverie-hu-tao-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/luminous-cryo-elegance-eula-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/divine-meditation-raiden-shogun-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/celestial-eclipse-raiden-shogun-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/frost-ballet-eula-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/epic-battle-scene-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/butterfly-dream-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/lumine-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/sangonomiya-kokomi",
    "https://www.wallpaperengine.space/wallpaper/baal-kokomi",
    "https://www.wallpaperengine.space/wallpaper/klee",
    "https://www.wallpaperengine.space/wallpaper/a-midsummer-nights-owl-fischl-genshin-impact",
    "https://www.wallpaperengine.space/wallpaper/nilou",
    "https://www.wallpaperengine.space/wallpaper/kenqing",
    "https://www.wallpaperengine.space/wallpaper/kamisato-ayaka",
    "https://www.wallpaperengine.space/wallpaper/barbara-genshin",
    "https://www.wallpaperengine.space/wallpaper/ningguang",
    "https://www.wallpaperengine.space/wallpaper/eula",
    "https://www.wallpaperengine.space/wallpaper/genshin-impact-piano",
    "https://www.wallpaperengine.space/wallpaper/raiden-gaming",
    "https://www.wallpaperengine.space/wallpaper/ganyu-glaze",
    "https://www.wallpaperengine.space/wallpaper/mona",
    "https://www.wallpaperengine.space/wallpaper/raiden-shogun",
    "https://www.wallpaperengine.space/wallpaper/inazuma-shrine",
    "https://www.wallpaperengine.space/wallpaper/cooking",
    "https://www.wallpaperengine.space/wallpaper/kamisato-ayaka-love-yourself-genshin-impact",
]

GERAL_URLS = [
    "https://www.wallpaperengine.space/wallpaper/a-quiet-evening",
    "https://www.wallpaperengine.space/wallpaper/02-sakura",
    "https://www.wallpaperengine.space/wallpaper/painting-sharks-over-turquoise-water",
    "https://www.wallpaperengine.space/wallpaper/beneath-the-seventh-red-shadow-creature",
]

# Best of space collection slugs
SPACE_COLLECTION_SLUGS = [
    "astronaut-floating",
    "aurora-lake-4k",
    "blue-star",
    "clear-sky",
    "colorful-space-4k",
    "colourfull-space-walk",
    "drowning-in-space",
    "dual-1440p-space",
    "earth-outer-space",
    "floating-in-space",
    "flowing-starry-sky-3",
    "full-moon",
    "galactic-symphony",
    "galaxy",
    "gargantua-black-hole",
    "halo-echoes-1-a-final-bullet",
    "nebula-transformation",
    "neutron-star",
    "night-sky",
    "noire-night",
    "planet-space",
    "red-nebula",
    "retro-lake",
    "spaceman",
    "stars-fall",
    "the-dark-night",
]

for s in SPACE_COLLECTION_SLUGS:
    GERAL_URLS.append(f"https://www.wallpaperengine.space/wallpaper/{s}")

def extract_slug(url: str) -> str:
    m = re.search(r'/wallpaper/([a-zA-Z0-9\-_]+)', url)
    if m:
        return m.group(1)
    return url.strip().strip('/')

def get_video_specs(filepath: str):
    try:
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        out = subprocess.run([exe, '-i', filepath], capture_output=True, text=True, errors='ignore')
        res_match = re.search(r'(\d{3,4}x\d{3,4})', out.stderr)
        fps_match = re.search(r'(\d+(?:\.\d+)?)\s*fps', out.stderr)
        dur_match = re.search(r'Duration:\s*(\d+:\d+:\d+\.\d+)', out.stderr)
        resolution = res_match.group(1) if res_match else "Desconhecida"
        fps = fps_match.group(1) if fps_match else "?"
        duration = dur_match.group(1) if dur_match else "?"
        return resolution, fps, duration
    except Exception:
        return "Desconhecida", "?", "?"

def download_item(item):
    url, target_dir, category = item
    slug = extract_slug(url)
    dest_path = os.path.join(target_dir, f"{slug}.mp4")

    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 100000:
        res, fps, dur = get_video_specs(dest_path)
        sz_mb = os.path.getsize(dest_path) / (1024 * 1024)
        return {
            'slug': slug,
            'category': category,
            'status': 'EXISTING',
            'size_mb': sz_mb,
            'resolution': res,
            'fps': fps,
            'path': dest_path
        }

    # Possible candidate URLs on CDN
    candidate_urls = [
        f"https://media.wallpaperengine.space/fallback/live-capture/v1/{slug}.mp4",
        f"https://media.wallpaperengine.space/wallpapers/v1/{slug}.mp4",
        f"https://media.wallpaperengine.space/wallpapers/v1/{slug}-4k.mp4",
        f"https://media.wallpaperengine.space/wallpapers/v1/{slug}_4k.mp4"
    ]

    downloaded = False
    chosen_url = None

    for c_url in candidate_urls:
        try:
            head = requests.head(c_url, headers=HEADERS, timeout=8)
            if head.status_code == 200:
                chosen_url = c_url
                break
        except Exception:
            continue

    if not chosen_url:
        # Fallback to direct default v1
        chosen_url = candidate_urls[0]

    try:
        r = requests.get(chosen_url, headers=HEADERS, stream=True, timeout=25)
        if r.status_code == 200:
            with open(dest_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
            downloaded = True
        else:
            return {
                'slug': slug,
                'category': category,
                'status': f'FAIL (HTTP {r.status_code})',
                'size_mb': 0,
                'resolution': 'N/A',
                'fps': 'N/A',
                'path': None
            }
    except Exception as e:
        return {
            'slug': slug,
            'category': category,
            'status': f'ERROR ({e})',
            'size_mb': 0,
            'resolution': 'N/A',
            'fps': 'N/A',
            'path': None
        }

    if downloaded and os.path.exists(dest_path):
        res, fps, dur = get_video_specs(dest_path)
        sz_mb = os.path.getsize(dest_path) / (1024 * 1024)
        return {
            'slug': slug,
            'category': category,
            'status': 'SUCCESS',
            'size_mb': sz_mb,
            'resolution': res,
            'fps': fps,
            'path': dest_path
        }

    return {
        'slug': slug,
        'category': category,
        'status': 'FAIL (Corrupted/Empty)',
        'size_mb': 0,
        'resolution': 'N/A',
        'fps': 'N/A',
        'path': None
    }

def main():
    items = []
    for u in ROOT_URLS:
        items.append((u, ROOT_DIR, "RAIZ"))
    for u in GERAL_URLS:
        items.append((u, GERAL_DIR, "GERAL"))

    print(f"=== INICIANDO DOWNLOAD EM LOTE ({len(items)} Wallpapers) ===")
    print(f"Raiz: {ROOT_DIR} ({len(ROOT_URLS)} itens)")
    print(f"Geral: {GERAL_DIR} ({len(GERAL_URLS)} itens)")
    print("=" * 60)

    results = []
    start_time = time.time()

    # Parallel download with 5 threads for high speed
    with ThreadPoolExecutor(max_workers=5) as executor:
        future_to_item = {executor.submit(download_item, it): it for it in items}
        completed = 0
        total = len(items)
        for future in as_completed(future_to_item):
            completed += 1
            res = future.result()
            results.append(res)
            print(f"[{completed:02d}/{total:02d}] [{res['category']}] {res['status']}: {res['slug']} | {res['resolution']} @ {res['fps']}fps ({res['size_mb']:.2f} MB)")

    elapsed = time.time() - start_time
    print("=" * 60)
    print(f"Finalizado em {elapsed:.1f}s!")

    success_list = [r for r in results if r['status'] in ('SUCCESS', 'EXISTING')]
    fail_list = [r for r in results if r['status'] not in ('SUCCESS', 'EXISTING')]

    print(f"Sucesso: {len(success_list)}/{len(items)}")
    if fail_list:
        print(f"Falhas ({len(fail_list)}):")
        for f in fail_list:
            print(f" - {f['slug']}: {f['status']}")

    # Write summary manifest
    manifest_path = os.path.join(ROOT_DIR, "manifest.txt")
    with open(manifest_path, 'w', encoding='utf-8') as mf:
        mf.write(f"Relatório de Download de Wallpapers - Total: {len(success_list)}/{len(items)}\n")
        mf.write("=" * 75 + "\n\n")
        mf.write("--- RAIZ ---\n")
        for r in sorted([x for x in success_list if x['category'] == 'RAIZ'], key=lambda x: x['slug']):
            mf.write(f"{r['slug']}.mp4 | {r['resolution']} | {r['fps']}fps | {r['size_mb']:.2f} MB\n")
        mf.write("\n--- GERAL ---\n")
        for r in sorted([x for x in success_list if x['category'] == 'GERAL'], key=lambda x: x['slug']):
            mf.write(f"{r['slug']}.mp4 | {r['resolution']} | {r['fps']}fps | {r['size_mb']:.2f} MB\n")

    print(f"Manifesto salvo em: {manifest_path}")

if __name__ == '__main__':
    main()
