# HANDOFF - Discord Unlock (v11.7)

## 1. Projeto
Discord Unlock (`C:\Dc unlock` e ambiente de desenvolvimento `C:\Users\Stefany\Videos\unlock beta tester\unlock beta tester`).
Aplicação desktop de alta performance em C++20 nativo / WebView2 para desbloqueio, gravação e otimização do Discord.

## 2. Estado Atual
- **Status Geral**: `[FUNCIONANDO / PRODUÇÃO]`
- **Versão Atual**: `11.7` (Constante `CURRENT_VERSION = "11.7"`, `version.txt` = `11.7`, manifesto = `11.7`).
- **Compilação**: `[FUNCIONANDO]` — MSVC C++20 via `build.ps1` exit code 0.
- **Deploy Cloudflare**: `[FUNCIONANDO / DEPLOY REALIZADO]` — Publicado com sucesso via `publicar_cloudflare.ps1` (wrangler):
  - API pública: `https://discord-unlock-api.st4rs.workers.dev` (manifesto, executáveis 11.7, hashes e protocolo de sincronização 2 verificados externamente).
  - Painel administrativo: `https://discord-unlock-admin.st4rs.workers.dev`
- **Sincronização de Pastas**:
  - `C:\Users\Stefany\Videos\unlock beta tester\unlock beta tester` é a pasta de trabalho oficial da v11.7.

## 3. Resumo da Correção Crítica (v11.7)
1. `[RESOLVIDO]` **Banner não invade telas de servidor**:
   - A descoberta do perfil deixou de aceitar contêineres genéricos e blocos arbitrários com `background-image`.
   - O CSS público mantém avatares, enquanto banners são aplicados apenas em perfis verificados pelo renderizador.
2. `[RESOLVIDO]` **Tela de autenticação isolada**:
   - Configurações, modais e controles autenticados ficam ocultos enquanto a chave está sendo validada.
3. `[RESOLVIDO]` **Abertura duplicada**:
   - O lançamento comum e a transição para a tarefa elevada agora são serializados; uma segunda instância aguarda a primeira janela e encerra.

## 4. Correção anterior preservada (v11.6)
1. `[RESOLVIDO]` **Avatar e banner DU sobre perfis Nitro oficiais**:
   - A resposta pública já continha `avatarUrl`, mas o cliente 11.5 descartava esse campo; a 11.6 aplica avatar e banner em camadas próprias e preserva máscara, status e decoração oficiais.
   - Perfis aninhados são consolidados para evitar duas camadas concorrendo no mesmo avatar/banner.
2. `[RESOLVIDO]` **Posição X/Y do avatar**:
   - X/Y agora produz deslocamento visível mesmo em imagem quadrada e tamanho abaixo de 72 px; editor e Discord usam a mesma transformação.
3. `[RESOLVIDO]` **Itens da Loja sobre visuais Nitro**:
   - Fundos salvos como `banner.url` são preservados pela rede e pintados sobre o banner oficial sem corromper o hash Nitro.
   - Decorações/efeitos DU substituem temporariamente os oficiais e a remoção restaura o estado original.
4. `[RESOLVIDO]` **Publicação e compatibilidade**:
   - O publicador passou a usar a fonte oficial `server`, não a cópia histórica `teste de servidor`.
   - `update-manifest.json`, hashes por artefato e `version_sha256.txt` foram validados contra downloads reais do CDN.

## 5. Correção anterior preservada (v11.5)
1. `[RESOLVIDO]` **Correção dos Avatares Gigantes em Mensagens do Chat**:
   - Identificada a causa raiz: CSS de avatar (`img[src*="/avatars/..."]`) continha `width: 100% !important; height: 100% !important;`. No chat do Discord, isso forçava o avatar a assumir 100% da largura da linha da mensagem (~700px), transformando-o numa elipse/ovo gigante horizontal.
   - Removido `width: 100% !important; height: 100% !important;` tanto do client local (`profile_renderer.js`) quanto da worker Cloudflare (`teste de servidor/src/index.ts`).
   - Implementado sanitizador automático no cliente para limpar regras malformadas de terceiros antes de injetar na DOM.
   - Adicionada blindagem CSS global (`ensureAvatarSizingCss`) forçando:
     - Chat: 40px × 40px circular (`border-radius: 50% !important; aspect-ratio: 1/1 !important; object-fit: cover !important`).
     - Respostas/compacto: 16px × 16px.
     - Painéis e listas de amigos: 32px × 32px.
