// Google Apps Script — Catálogo automático do Discord Unlock v8.2.
// Organize os papéis de parede no Google Drive por pastas de Categorias (ex: Anime, Games, Carros, Espaço, Natureza, Geral).
// Dentro de cada categoria, os wallpapers podem ficar em subpastas próprias sem que o nome da subpasta vire tag!
const ROOT_FOLDER_ID = '1vB1aVlCL2oBD6QduAFkzLMWFg0LRJSm_';

function doGet() {
  const entries = [];
  const seenDriveIds = {};
  const seenNames = {};
  scanFolder_(DriveApp.getFolderById(ROOT_FOLDER_ID), '', entries, true, seenDriveIds, seenNames);
  entries.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return ContentService.createTextOutput(JSON.stringify(entries))
    .setMimeType(ContentService.MimeType.JSON);
}

function scanFolder_(folder, inheritedTag, entries, isRoot, seenDriveIds, seenNames) {
  const isCurrentRoot = (folder.getId() === ROOT_FOLDER_ID) || isRoot;
  // Se for a raiz, tag padrão é 'Geral'.
  // Se estiver dentro de uma pasta de categoria (ou subpasta dela), mantém a categoria herdada!
  const currentTag = isCurrentRoot ? 'Geral' : (inheritedTag || folder.getName());

  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (!file.getMimeType().startsWith('video/')) continue;
    
    const id = file.getId();
    if (seenDriveIds[id]) continue;
    seenDriveIds[id] = true;

    const baseName = file.getName().replace(/\.[^.]+$/, '');
    const cleanKey = baseName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleanKey && seenNames[cleanKey]) continue;
    if (cleanKey) seenNames[cleanKey] = true;

    entries.push({
      id: 'theme_' + id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
      name: baseName,
      desc: 'Wallpaper animado MP4 em alta qualidade.',
      tags: [currentTag],
      preview_url: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w640',
      download_url: 'https://drive.google.com/uc?export=download&id=' + id + '&confirm=t',
      drive_file_id: id,
      file_name: file.getName(),
      size_mb: Math.round(file.getSize() / 1048576 * 10) / 10,
      badge: 'MP4 ANIMADO',
      accent: '#6366f1'
    });
  }

  const folders = folder.getFolders();
  while (folders.hasNext()) {
    const child = folders.next();
    // Se estivermos na raiz, o nome da pasta filha define a CATEGORIA/TAG (ex: Anime, Games, Geral, etc.).
    // Se já estivermos dentro de uma categoria, as subpastas onde ficam os wallpapers NUNCA viram tags:
    // elas herdam a tag da categoria principal!
    const nextTag = isCurrentRoot ? child.getName() : currentTag;
    scanFolder_(child, nextTag, entries, false, seenDriveIds, seenNames);
  }
}