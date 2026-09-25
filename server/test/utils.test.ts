import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  cleanDisplayName,
  cleanMessage,
  isAllowedAttachment,
  normalizeGofileContentId,
  normalizeGofileShareUrl,
  randomPublicId,
  safeFileName
} from '../src/utils';

describe('DC ID', () => {
  it('gera um identificador compartilhável sem caracteres ambíguos', () => {
    expect(randomPublicId(new Uint8Array([0,1,2,3,4,5,6,7,8,9])))
      .toBe('DU-ABCDE-FGHJK');
  });
});

describe('texto e nomes', () => {
  it('remove controles e limita o nome', () => {
    expect(cleanDisplayName('  Stefy\u0000   Stars  ')).toBe('Stefy Stars');
  });
  it('remove byte nulo da mensagem', () => {
    expect(cleanMessage('oi\u0000 mundo')).toBe('oi mundo');
  });
  it('limpa nomes de arquivo para Windows', () => {
    expect(safeFileName('foto:*?<>.png')).toBe('foto_____.png');
  });
});

describe('anexos GoFile', () => {
  it('aceita mídia permitida até 200 MB', () => {
    expect(isAllowedAttachment('video/mp4', MAX_ATTACHMENT_BYTES)).toBe(true);
    expect(isAllowedAttachment('image/png', 1)).toBe(true);
  });
  it('bloqueia executáveis, compactados e excesso de tamanho', () => {
    expect(isAllowedAttachment('application/x-msdownload', 100)).toBe(false);
    expect(isAllowedAttachment('application/zip', 100)).toBe(false);
    expect(isAllowedAttachment('video/mp4', MAX_ATTACHMENT_BYTES + 1)).toBe(false);
  });
  it('aceita somente URLs HTTPS do GoFile', () => {
    expect(normalizeGofileShareUrl('https://gofile.io/d/abc123'))
      .toBe('https://gofile.io/d/abc123');
    expect(() => normalizeGofileShareUrl('http://gofile.io/d/abc123')).toThrow();
    expect(() => normalizeGofileShareUrl('https://gofile.io.evil.example/d/abc123')).toThrow();
    expect(() => normalizeGofileShareUrl('https://example.com/gofile')).toThrow();
  });
  it('valida o identificador retornado pelo GoFile', () => {
    expect(normalizeGofileContentId('abcDEF_123')).toBe('abcDEF_123');
    expect(() => normalizeGofileContentId('../segredo')).toThrow();
  });
});
