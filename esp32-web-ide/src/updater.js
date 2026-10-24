/**
 * Проверка обновлений ESP32 Studio через официальный GitHub Release `esp32-studio-latest`.
 *
 * Тег `esp32-studio-latest` постоянный, а версия пакета может оставаться `1.0.0`
 * между сборками, поэтому наличие обновления определяется не только по `version`,
 * но и по идентификатору коммита (`commit` / `shortCommit`) и метаданным релиза
 * (встроенный JSON-комментарий в `body`, строка коммита или дата обновления артефактов).
 */

export const RELEASE_REPO = 'homa95120-wq/-';
export const RELEASE_TAG = 'esp32-studio-latest';
export const RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${RELEASE_TAG}`;
export const RELEASE_PAGE_URL = `https://github.com/${RELEASE_REPO}/releases/tag/${RELEASE_TAG}`;
export const ALLOWED_DOWNLOAD_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}/`;

export function normalizeCommit(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(trimmed) ? trimmed : '';
}

export function commitsMatch(a, b) {
  const ca = normalizeCommit(a);
  const cb = normalizeCommit(b);
  if (!ca || !cb) return false;
  return ca.startsWith(cb) || cb.startsWith(ca);
}

export function isSafeReleaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return false;
    return (
      rawUrl.startsWith(ALLOWED_DOWNLOAD_PREFIX) ||
      rawUrl === RELEASE_PAGE_URL ||
      rawUrl.startsWith(`https://github.com/${RELEASE_REPO}/releases/`)
    );
  } catch {
    return false;
  }
}

export function getLocalBuildInfo(override) {
  if (override && typeof override === 'object') {
    const commit = normalizeCommit(override.commit);
    return {
      version: String(override.version || '1.0.0'),
      commit: commit || 'dev',
      shortCommit: commit ? commit.slice(0, 7) : 'dev',
      builtAt: override.builtAt || null,
      releaseTag: override.releaseTag || RELEASE_TAG,
    };
  }
  const injected = typeof __ESP32_STUDIO_BUILD__ !== 'undefined' ? __ESP32_STUDIO_BUILD__ : null;
  const commit = normalizeCommit(injected?.commit);
  return {
    version: String(injected?.version || '1.0.0'),
    commit: commit || 'dev',
    shortCommit: commit ? commit.slice(0, 7) : 'dev',
    builtAt: injected?.builtAt || null,
    releaseTag: injected?.releaseTag || RELEASE_TAG,
  };
}

export function parseReleaseMetadata(release) {
  if (!release || typeof release !== 'object') {
    throw new Error('Некорректный ответ GitHub API (пустой объект релиза).');
  }
  if (release.tag_name && release.tag_name !== RELEASE_TAG) {
    throw new Error(`Неожиданный тег релиза: ${release.tag_name} (ожидался ${RELEASE_TAG}).`);
  }

  const body = typeof release.body === 'string' ? release.body : '';
  let embedded = null;
  const metaMatch = body.match(/<!--\s*esp32-studio-release:\s*(\{[\s\S]*?\})\s*-->/);
  if (metaMatch) {
    try {
      embedded = JSON.parse(metaMatch[1]);
    } catch {}
  }

  const bodyCommitMatch =
    body.match(/Сборка\s*\(коммит\)\s*:\s*`?([0-9a-fA-F]{7,40})`?/i) ||
    body.match(/commit\s*:\s*`?([0-9a-fA-F]{7,40})`?/i);

  const commit =
    normalizeCommit(embedded?.commit) ||
    normalizeCommit(bodyCommitMatch?.[1]) ||
    normalizeCommit(release.target_commitish);

  const rawAssets = Array.isArray(release.assets) ? release.assets : [];
  const safeAssets = rawAssets
    .filter(a => a && typeof a.name === 'string' && isSafeReleaseUrl(a.browser_download_url))
    .map(a => ({
      name: a.name,
      url: a.browser_download_url,
      size: typeof a.size === 'number' ? a.size : 0,
      updatedAt: a.updated_at || a.created_at || null,
    }));

  const winExeAssets = safeAssets.filter(a => /\.exe$/i.test(a.name));
  const portableAsset = winExeAssets.find(a => /portable/i.test(a.name)) || null;
  const setupAsset = winExeAssets.find(a => /setup/i.test(a.name)) || winExeAssets.find(a => !/portable/i.test(a.name)) || null;

  let version = embedded?.version ? String(embedded.version) : '';
  if (!version) {
    const bodyVerMatch = body.match(/Версия\s*:\s*`?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`?/i);
    if (bodyVerMatch) version = bodyVerMatch[1];
  }
  if (!version) {
    for (const a of winExeAssets) {
      const m = a.name.match(/(\d+\.\d+\.\d+)/);
      if (m) { version = m[1]; break; }
    }
  }
  if (!version) version = '1.0.0';

  const timestamps = [
    embedded?.publishedAt,
    ...winExeAssets.map(a => a.updatedAt),
    release.published_at,
    release.created_at,
  ]
    .filter(Boolean)
    .map(t => ({ raw: t, ms: Date.parse(t) }))
    .filter(x => Number.isFinite(x.ms))
    .sort((a, b) => b.ms - a.ms);

  const updatedAt = timestamps[0]?.raw || null;
  const pageUrl = isSafeReleaseUrl(release.html_url) ? release.html_url : RELEASE_PAGE_URL;

  return {
    tag: release.tag_name || RELEASE_TAG,
    name: release.name || 'ESP32 Studio',
    version,
    commit: commit || '',
    shortCommit: commit ? commit.slice(0, 7) : '',
    updatedAt,
    pageUrl,
    portableAsset,
    setupAsset,
    assets: safeAssets,
  };
}

export function selectWindowsDownload(remoteMeta, { portable = false } = {}) {
  const portableAsset = remoteMeta?.portableAsset || null;
  const setupAsset = remoteMeta?.setupAsset || null;
  const primary = portable ? (portableAsset || setupAsset) : (setupAsset || portableAsset);
  const secondary = primary === portableAsset ? setupAsset : portableAsset;
  return {
    primary,
    secondary,
    portableAsset,
    setupAsset,
  };
}

export function compareBuilds(localBuild, remoteMeta) {
  const localVer = String(localBuild?.version || '1.0.0').trim();
  const remoteVer = String(remoteMeta?.version || '1.0.0').trim();
  const localCommit = normalizeCommit(localBuild?.commit);
  const remoteCommit = normalizeCommit(remoteMeta?.commit);

  // 1. Различается номер версии
  if (localVer !== remoteVer) {
    return {
      hasUpdate: true,
      reason: 'version',
      summary: `Доступна новая версия ${remoteVer} (установлена ${localVer}).`,
    };
  }

  // 2. Оба коммита известны — определяем по коммиту (даже если версия осталась 1.0.0)
  if (localCommit && remoteCommit) {
    if (commitsMatch(localCommit, remoteCommit)) {
      return {
        hasUpdate: false,
        reason: 'same-commit',
        summary: `У вас установлена актуальная сборка (${localCommit.slice(0, 7)}).`,
      };
    }
    return {
      hasUpdate: true,
      reason: 'new-commit',
      summary: `Доступна новая сборка ${remoteCommit.slice(0, 7)} (текущая: ${localCommit.slice(0, 7)}).`,
    };
  }

  // 3. В релизе есть коммит, а локальная сборка без коммита (dev/ручная)
  if (remoteCommit && !localCommit) {
    return {
      hasUpdate: true,
      reason: 'untracked-local',
      summary: `В релизе опубликована сборка ${remoteCommit.slice(0, 7)} (текущая сборка без метки коммита).`,
    };
  }

  // 4. В релизе ещё нет метки коммита (старый формат релиза) — сравниваем дату обновления файлов
  const localMs = localBuild?.builtAt ? Date.parse(localBuild.builtAt) : NaN;
  const remoteMs = remoteMeta?.updatedAt ? Date.parse(remoteMeta.updatedAt) : NaN;
  if (Number.isFinite(remoteMs) && Number.isFinite(localMs)) {
    if (remoteMs > localMs) {
      return {
        hasUpdate: true,
        reason: 'newer-timestamp',
        summary: 'В официальном релизе esp32-studio-latest опубликованы более новые файлы сборки.',
      };
    }
    return {
      hasUpdate: false,
      reason: 'up-to-date-time',
      summary: 'Установленная сборка не старше опубликованного релиза.',
    };
  }

  return {
    hasUpdate: true,
    reason: 'unknown-commit',
    summary: 'Доступен официальный релиз esp32-studio-latest на GitHub (метаданные коммита не указаны).',
  };
}

export function formatBuildDate(iso) {
  if (!iso) return 'неизвестно';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'неизвестно';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export async function checkGitHubUpdate({
  fetchImpl = globalThis.fetch,
  localBuild = getLocalBuildInfo(),
  portable = Boolean(globalThis.esp32studio?.portable),
  timeoutMs = 10000,
} = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Нет подключения к интернету. Проверь сеть и попробуй снова.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Функция сетевого запроса недоступна в этой среде.');
  }

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  let res;
  try {
    res = await fetchImpl(RELEASE_API_URL, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: ctrl?.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа от GitHub. Проверь подключение к интернету.');
    }
    throw new Error('Не удалось связаться с GitHub (нет сети или сервер недоступен).');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res || typeof res.ok !== 'boolean') {
    throw new Error('Некорректный ответ при проверке обновлений на GitHub.');
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Официальный релиз ${RELEASE_TAG} не найден на GitHub (HTTP 404).`);
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error(`Превышен лимит запросов к GitHub API (HTTP ${res.status}). Попробуй позже или открой страницу релиза.`);
    }
    throw new Error(`Ошибка сервера GitHub при проверке релиза (HTTP ${res.status}).`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('Не удалось разобрать JSON-ответ от GitHub API.');
  }

  const remote = parseReleaseMetadata(json);
  const comparison = compareBuilds(localBuild, remote);
  const downloads = selectWindowsDownload(remote, { portable });

  return {
    local: localBuild,
    remote,
    hasUpdate: comparison.hasUpdate,
    reason: comparison.reason,
    summary: comparison.summary,
    downloads,
  };
}
