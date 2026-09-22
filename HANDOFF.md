# HANDOFF - Discord Unlock (Wallpaper Engine & Galeria de Temas)

## 1. Projeto
Discord Unlock (`C:\DiscordUnlock` e ambiente de desenvolvimento `C:\unlock beta tester`).
Aplicação desktop C++ / WebView2 para personalização e otimização do Discord.

## 2. Estado Atual
- **Status Geral**: `[FUNCIONANDO]`
- **Versão Atual**: `8.4` (REGRA EXPLÍCITA DO USUÁRIO: NÃO alterar o número de versão nem subir para o Git até autorização expressa).
- **Compilação**: `[FUNCIONANDO]` — MSVC C++20 via `C:\unlock beta tester\build.ps1`. Todos os binários compilam com código 0.
- **Deploy**: `[FUNCIONANDO]` — Binários e assets atualizados em `C:\DiscordUnlock\`:
  - `DiscordUnlock.exe`
  - `DiscordUnlock_Special.exe`
  - `wallpaper_engine_renderer.html`

## 3. Status das Solicitações do Usuário
1. `[RESOLVIDO]` **Eliminar temas duplicados**: O scanner `getLocalCustomThemesJson()` agora ignora arquivos/pastas de engine (`local_engine_` e `_engine`), e o frontend descarta duplicatas.
2. `[RESOLVIDO]` **Isolar temas do Engine**: A aba "Wallpaper Engine" agora exibe com exclusividade temas do motor. Nenhuma outra aba ("Todos", "Meus temas", etc.) exibe temas de engine, mesmo após importados/baixados.
3. `[RESOLVIDO]` **Corrigir pausa da animação**: `wallpaper_engine_renderer.html` agora utiliza `preserveDrawingBuffer: true` e renderiza a cena com tempo congelado (`pauseTime`) em vez de abortar com tela preta.
4. `[RESOLVIDO]` **Restaurar animação de temas nativos (ex: 1442116244)**: `applyDiscordThemeCss()` prioriza mídias animadas nativas (`wallpaper_hd.gif`, `.mp4`, `.webm`) para rodar diretamente via tags do Discord com taxa de quadros completa. O WebGL renderer fica restrito a cenas de shaders sem vídeo pré-renderizado.
5. `[RESOLVIDO]` **Exibir nome real do wallpaper**: Extração automática do campo `"title"` a partir do `project.json` na leitura e preservação durante a importação para a pasta local.

---

## 4. Arquivos Importantes
| Arquivo | Função | Estado |
|---|---|---|
| `C:\unlock beta tester\gui_main.cpp` | Código-fonte C++ e interface HTML/JS embutida | `[FUNCIONANDO]` |
| `C:\unlock beta tester\wallpaper_engine_renderer.html` | Renderizador WebGL multi-layer (shaders, bloom, shake, pause) | `[FUNCIONANDO]` |
| `C:\unlock beta tester\build.ps1` | Script de build com MSVC C++20 | `[FUNCIONANDO]` |
| `C:\DiscordUnlock\` | Diretório de produção dos executáveis e assets | `[FUNCIONANDO]` |

---

## 5. Comandos Importantes
```powershell
# Compilar projeto (~30s)
powershell -ExecutionPolicy Bypass -File "C:\unlock beta tester\build.ps1"

# Deploy para produção
Copy-Item "C:\unlock beta tester\DiscordUnlock.exe" "C:\DiscordUnlock\DiscordUnlock.exe" -Force
Copy-Item "C:\unlock beta tester\DiscordUnlock_Special.exe" "C:\DiscordUnlock\DiscordUnlock_Special.exe" -Force
Copy-Item "C:\unlock beta tester\wallpaper_engine_renderer.html" "C:\DiscordUnlock\wallpaper_engine_renderer.html" -Force
```
