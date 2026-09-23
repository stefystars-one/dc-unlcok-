# HANDOFF - Discord Unlock (Wallpaper Engine, Banner Preview & Auto-Update)

## 1. Projeto
Discord Unlock (`C:\DiscordUnlock` e ambiente de desenvolvimento `C:\unlock beta tester`).
Aplicação desktop C++ / WebView2 para personalização e otimização do Discord.

## 2. Estado Atual
- **Status Geral**: `[FUNCIONANDO]`
- **Versão Atual**: `8.9` (Release v8.9 publicado como Latest no GitHub com todos os 7 assets).
- **Compilação**: `[FUNCIONANDO]` — MSVC C++20 via `C:\unlock beta tester\build.ps1`.
- **Deploy**: `[FUNCIONANDO]` — Release GitHub v8.9 ativo com todos os arquivos:
  - `DiscordUnlock.exe` (13.771.776 bytes)
  - `DiscordUnlock_Special.exe` (13.578.240 bytes)
  - `update-manifest.json` (com chaves `artifacts` e `files`)
  - `version.txt` (`8.9`)
  - `version_sha256.txt`
  - `DiscordUnlock_Instalar.ps1`
  - `themes_catalog.json`

## 3. Status das Solicitações do Usuário
1. `[RESOLVIDO]` **Slider de Tamanho restaurado**: Slider (80–400px, padrão 200px) mantido na preview do Banner de Perfil em conjunto com aspect-ratio automático 5:2.
2. `[RESOLVIDO]` **Versão 8.9**: Definida como 8.9 para total retrocompatibilidade com clientes em 8.7 (comparação numérica e via `std::stod`).
3. `[RESOLVIDO]` **Upload completo de todos os assets da Release**: Upload de todos os 7 arquivos (incluindo `update-manifest.json`, `version.txt`, `version_sha256.txt`, script de instalação e catálogo de temas) no GitHub Releases v8.9. O endpoint `/releases/latest/download/update-manifest.json` agora responde HTTP 200 OK.
4. `[RESOLVIDO]` **Detecção de Atualizações**: Clientes v8.7 e anteriores agora encontram com sucesso a versão 8.9 via GitHub Releases.
