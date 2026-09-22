"""
Script para download em lote de wallpapers animados em vídeo do Wallpaper Engine Space.
Extrai e baixa os vídeos MP4 na máxima qualidade disponível (1080p Full HD).
"""

import os
import re
import sys
import argparse
import requests

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

def extract_slug(url_or_slug: str) -> str:
    url_or_slug = url_or_slug.strip()
    match = re.search(r'/wallpaper/([a-zA-Z0-9\-_]+)', url_or_slug)
    if match:
        return match.group(1)
    # Se já for o slug direto
    return url_or_slug.strip().strip('/')

def download_wallpaper(url_or_slug: str, output_dir: str = "wallpapers") -> bool:
    slug = extract_slug(url_or_slug)
    if not slug:
        print(f"[ERRO] Link ou identificador inválido: {url_or_slug}")
        return False

    os.makedirs(output_dir, exist_ok=True)
    video_url = f"https://media.wallpaperengine.space/wallpapers/v1/{slug}.mp4"
    dest_path = os.path.join(output_dir, f"{slug}.mp4")

    print(f"\n[+] Baixando: {slug}...")
    print(f"    URL: {video_url}")

    try:
        response = requests.get(video_url, headers=HEADERS, stream=True, timeout=20)
        if response.status_code != 200:
            print(f"    [FALHA] Código HTTP {response.status_code} ao buscar vídeo.")
            return False

        total_size = int(response.headers.get('content-length', 0))
        downloaded = 0

        with open(dest_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = (downloaded / total_size) * 100
                        mb_done = downloaded / (1024 * 1024)
                        mb_total = total_size / (1024 * 1024)
                        sys.stdout.write(f"\r    Progresso: {percent:.1f}% ({mb_done:.2f}MB / {mb_total:.2f}MB)")
                        sys.stdout.flush()

        print(f"\n    [OK] Salvo com sucesso em: {dest_path}")
        return True
    except Exception as e:
        print(f"    [ERRO] Ocorreu uma exceção: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(description="Baixar vídeos do Wallpaper Engine Space.")
    parser.add_argument('links', nargs='*', help="Links ou slugs dos wallpapers")
    parser.add_argument('-f', '--file', help="Arquivo de texto com lista de links (um por linha)")
    parser.add_argument('-o', '--output', default="wallpapers", help="Diretório de saída (padrão: wallpapers)")
    args = parser.parse_args()

    urls_to_download = list(args.links)
    if args.file and os.path.exists(args.file):
        with open(args.file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    urls_to_download.append(line)

    if not urls_to_download:
        print("Nenhum link fornecido!")
        print("Uso:")
        print("  python download_wallpapers.py <link_ou_slug> [outro_link ...]")
        print("  python download_wallpapers.py -f links.txt")
        return

    print(f"Iniciando download de {len(urls_to_download)} wallpaper(s)...")
    success_count = 0
    for u in urls_to_download:
        if download_wallpaper(u, args.output):
            success_count += 1

    print(f"\nFinalizado! {success_count}/{len(urls_to_download)} vídeos baixados em '{args.output}'.")

if __name__ == '__main__':
    main()
