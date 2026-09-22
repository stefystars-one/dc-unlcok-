# HANDOFF - Discord Unlock (Wallpaper Engine, Temas de Cores e Galeria)

## 1. Projeto
Discord Unlock (`C:\DiscordUnlock` e ambiente de desenvolvimento `C:\unlock beta tester`).
Aplicação desktop C++ / WebView2 para personalização e otimização do Discord.

## 2. Estado Atual
- **Status Geral**: `[FUNCIONANDO]`
- **Versão Atual**: `8.6`
- **Compilação**: `[FUNCIONANDO]` — MSVC C++20 via `C:\unlock beta tester\build.ps1`. Todos os binários compilam com código 0.
- **Deploy**: `[FUNCIONANDO]` — Binários e assets atualizados em `C:\DiscordUnlock\`:
  - `DiscordUnlock.exe` (SHA256: `f0dfd9559fa628614caabcdbf67443a4f231f97a15d4d959449c3c8d55ed2eef`)
  - `DiscordUnlock_Special.exe` (SHA256: `cd1950e2a43eb754f0754513adc49640b4ded264c97b32bf996bec61806b72f5`)
  - `wallpaper_engine_renderer.html`
- **GitHub**:
  - Repositório `https://github.com/stefystars-one/dc-unlcok-` sincronizado na branch `main`.
  - Release `v8.6` publicada com todos os assets anexados (`update-manifest.json`, `DiscordUnlock.exe`, `DiscordUnlock_Special.exe`, `DiscordUnlock_Instalar.ps1`, `themes_catalog.json`, `version.txt`, `version_sha256.txt`).

## 3. Status das Solicitações do Usuário
1. `[RESOLVIDO]` **Ocultar botão de pausa em temas Wallpaper Engine**: `isAnimatedTheme` no frontend agora valida `!isEngine`, evitando que o botão ⏸ apareça nos cards da aba de Engine.
2. `[RESOLVIDO]` **Seletor de cor duplo (Fundo + Acento) com preview em tempo real**: O card personalizável possui seletor dedicado de cor de fundo e cor de destaque, com atualização imediata via `previewCustomColorTheme()`.
3. `[RESOLVIDO]` **Aplicação da cor personalizada de fundo**: O payload `apply_theme` transporta a cor de fundo com prefixo `bg:` para o C++ no `applyDiscordThemeCss`, definindo `bgOverride` e aplicando o estilo no `#app-mount` do Discord.
4. `[RESOLVIDO]` **Aprimoramento do CSS dos temas de cor estáticos**: A flag `isStaticColor` diferencia temas de cores estáticas de temas com vídeo/wallpaper, aplicando cores de fundo (`primary`, `secondary`, `tertiary`) nas sidebars, canais e painéis em vez de transparência vazia.
5. `[RESOLVIDO]` **Elevação para v8.6 e envio para o Git**: Versão atualizada em `version.txt`, `github/update-manifest.json`, `version_sha256.txt`, release criada no GitHub e push concluído.

---

## 4. Arquivos Importantes
| Arquivo | Função | Estado |
|---|---|---|
| `C:\unlock beta tester\gui_main.cpp` | Código-fonte C++ e interface HTML/JS embutida | `[FUNCIONANDO]` |
| `C:\DiscordUnlock\gui_main.cpp` | Espelho de produção do código-fonte | `[FUNCIONANDO]` |
| `C:\unlock beta tester\wallpaper_engine_renderer.html` | Renderizador WebGL multi-layer (shaders, bloom, shake, pause) | `[FUNCIONANDO]` |
| `C:\DiscordUnlock\github\update-manifest.json` | Manifesto de atualização v8.6 com hashes e URLs | `[FUNCIONANDO]` |
| `C:\DiscordUnlock\version.txt` | Arquivo de versão (`8.6`) | `[FUNCIONANDO]` |

---

## 5. Comandos Importantes
```powershell
# Compilar projeto (~30s)
powershell -ExecutionPolicy Bypass -File "C:\unlock beta tester\build.ps1"

# Iniciar / Reiniciar aplicação via agendador
schtasks /run /tn "\DiscordUnlock"
```
