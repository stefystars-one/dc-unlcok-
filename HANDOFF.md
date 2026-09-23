# HANDOFF - Discord Unlock (v9.0)

## 1. Projeto
Discord Unlock (`C:\DiscordUnlock` e ambiente de desenvolvimento `C:\unlock beta tester`).
Aplicação desktop de alta performance em C++20 nativo / WebView2 para desbloqueio, gravação e otimização do Discord.

## 2. Estado Atual
- **Status Geral**: `[FUNCIONANDO / PRODUÇÃO]`
- **Versão Atual**: `9.0` (Constante `CURRENT_VERSION = "9.0"`, `version.txt` = `9.0`, manifesto = `9.0`).
- **Compilação**: `[FUNCIONANDO]` — MSVC C++20 via `C:\unlock beta tester\build.ps1` exit code 0.
- **Deploy Cloudflare**: `[FUNCIONANDO]` — Publicado com sucesso via `publicar_cloudflare.ps1` (wrangler):
  - API pública: `https://discord-unlock-api.st4rs.workers.dev` (manifesto, executáveis, hashes e MOTD atualizados).
  - Painel administrativo: `https://discord-unlock-admin.st4rs.workers.dev/admin.html`
- **Deploy Git**: `[FUNCIONANDO]` — Repositório `stefystars-one/dc-unlcok-` sincronizado na branch `main`.

## 3. Principais Recursos e Alterações da Versão 9.0
1. `[RESOLVIDO]` **Gravador DXGI por Hardware até 4K • 120 FPS e 150 Mbps**:
   - Backend `recorder_engine.hpp` e `gui_main.cpp` atualizados para DXGI Desktop Duplication e Media Foundation.
   - Suporte a 120 FPS Gamer e taxa de bits balanceada de até 150 Mbps (`150000000` bps).
   - Modo de preset "Personalizado" (`#recCustomPanel`) com largura/altura customizada, seletor de FPS (15 a 120) e slider de bitrate contínuo (2 Mbps a 150 Mbps).
   - Configuração salva em `%APPDATA%\DiscordUnlock\recorder_config.json`.
2. `[RESOLVIDO]` **Replay Instantâneo em RAM**:
   - Buffer contínuo na memória RAM configurável de 15s até 5min.
   - Atalho de teclado global (<kbd>Ctrl + F10</kbd>) para exportar clipes instantaneamente sem impacto no jogo.
3. `[RESOLVIDO]` **Editor Lossless de Clipes**:
   - Corte direto sem recodificação (lossless trim) preservando a nitidez original.
   - Rotação do vídeo (90°, 180°, 270°) com controles customizados externos que não invertem com a rotação CSS.
4. `[RESOLVIDO]` **Galeria DU com Banners e Avatares Animados**:
   - Loja pesquisável por texto e categorias/chips com botões dedicados `🖼️ Banner`, `👤 Avatar` e `✨ Ambos`.
   - Painel administrativo no Cloudflare integrado para cadastro e moderação de novos assets.
5. `[RESOLVIDO]` **Aba Guia & Sobre Atualizada**:
   - Sub-aba dedicada `🎥 Gravador & Clipes (v9.0)` (`#sec-recorder`) com explicação do DXGI, 120 FPS, 150 Mbps, Replay e atalhos.
   - Sub-aba `ℹ️ Sobre & Versão 9.0` (`#sec-about`) com changelog oficial, arquitetura e garantias de segurança client-side.
   - Badges e navegação rápida sincronizados em `gui_main.cpp` e `ui/index.html`.
6. `[RESOLVIDO]` **Aviso do Dia (`motd.txt`) e Manifesto de Atualizações**:
   - `motd.txt` reformulado com o resumo oficial das novidades da versão 9.0.
   - `version.txt` fixado em `9.0`.
   - `update-manifest.json` com os novos hashes SHA-256 e tamanhos dos binários.
