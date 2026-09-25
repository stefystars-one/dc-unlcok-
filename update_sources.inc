// Update sources: Cloudflare primary + optional GitHub Releases manifest.
// The manifest is intentionally small and contains the version, direct file URL and SHA-256.
struct UpdatePackage {
  std::string version;
  std::string downloadUrl;
  std::string sha256;
  std::string source;
};

static std::string trimUpdateText(std::string value) {
  // Google Drive may return UTF-8 JSON with a BOM; it is not whitespace to the C locale.
  if (value.size() >= 3 && (unsigned char)value[0] == 0xEF &&
      (unsigned char)value[1] == 0xBB && (unsigned char)value[2] == 0xBF) {
    value.erase(0, 3);
  }
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), [](unsigned char c) { return !std::isspace(c); }));
  value.erase(std::find_if(value.rbegin(), value.rend(), [](unsigned char c) { return !std::isspace(c); }).base(), value.end());
  return value;
}
static bool isSha256Value(const std::string &value) {
  if (value.size() != 64) return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char c) { return std::isxdigit(c) != 0; });
}

static double updateVersionNumber(const std::string &value) {
  try {
    std::string normalized = trimUpdateText(value);
    std::replace(normalized.begin(), normalized.end(), ',', '.');
    std::stringstream stream(normalized);
    std::string part;
    unsigned long long pieces[3] = {0, 0, 0};
    int count = 0;
    while (std::getline(stream, part, '.')) {
      if (count >= 3 || part.empty() || !std::all_of(part.begin(), part.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) return -1.0;
      pieces[count] = std::stoull(part);
      if (pieces[count] > 999999) return -1.0;
      ++count;
    }
    if (count == 0) return -1.0;
    return static_cast<double>(pieces[0] * 1000000000000ULL + pieces[1] * 1000000ULL + pieces[2]);
  } catch (...) {
    return -1.0;
  }
}

static std::wstring githubLatestManifestUrlFromRepo(const std::string &repo) {
  // A release asset has a stable "latest/download" URL while each release
  // remains versioned and immutable on GitHub.
  if (repo.empty() || repo.find('/') == std::string::npos) return L"";
  return L"https://github.com/" + toWide(repo) + L"/releases/latest/download/update-manifest.json";
}

static std::wstring configuredGithubReleaseManifestUrl() {
  const std::wstring bundledManifestUrl =
    L"https://github.com/stefystars-one/dc-unlcok-/releases/latest/download/update-manifest.json";
  const fs::path configPath = fs::path(getCurrentExePath()).parent_path() / "update_sources.json";
  try {
    if (!fs::exists(configPath)) return bundledManifestUrl;
    std::ifstream config(configPath.string(), std::ios::binary);
    std::string json((std::istreambuf_iterator<char>(config)), std::istreambuf_iterator<char>());
    std::string directUrl = trimUpdateText(extractJsonField(json, "github_release_manifest_url"));
    if (directUrl.rfind("https://github.com/", 0) == 0) return toWide(directUrl);
    const std::wstring fromRepo = githubLatestManifestUrlFromRepo(trimUpdateText(extractJsonField(json, "github_repo")));
    return fromRepo.empty() ? bundledManifestUrl : fromRepo;
  } catch (...) {
    return bundledManifestUrl;
  }
}
static std::string downloadTextFromFullUrl(const std::wstring &url) {
  if (url.empty()) return "";
  const std::string fullUrl = toUtf8(url);
  std::string response = downloadViaWinInet(fullUrl);
  if (response.empty()) response = downloadViaCurl(fullUrl);
  return response;
}

static bool downloadUpdateBinaryFromUrl(const std::wstring &url, const std::wstring &targetFile) {
  if (url.empty()) return false;
  try {
    URL_COMPONENTS components = { 0 };
    components.dwStructSize = sizeof(components);
    wchar_t host[512] = { 0 };
    wchar_t path[4096] = { 0 };
    wchar_t extra[4096] = { 0 };
    components.lpszHostName = host;
    components.dwHostNameLength = (DWORD)_countof(host) - 1;
    components.lpszUrlPath = path;
    components.dwUrlPathLength = (DWORD)_countof(path) - 1;
    components.lpszExtraInfo = extra;
    components.dwExtraInfoLength = (DWORD)_countof(extra) - 1;

    if (!WinHttpCrackUrl(url.c_str(), (DWORD)url.size(), 0, &components)) return false;
    const std::wstring targetHost(components.lpszHostName, components.dwHostNameLength);
    const std::wstring targetPath = std::wstring(components.lpszUrlPath, components.dwUrlPathLength) +
                                    std::wstring(components.lpszExtraInfo, components.dwExtraInfoLength);
    const INTERNET_PORT port = components.nPort ? components.nPort :
      (components.nScheme == INTERNET_SCHEME_HTTP ? INTERNET_DEFAULT_HTTP_PORT : INTERNET_DEFAULT_HTTPS_PORT);
    const DWORD flags = components.nScheme == INTERNET_SCHEME_HTTP ? 0 : WINHTTP_FLAG_SECURE;

    HINTERNET session = WinHttpOpen(L"DiscordUnlockUpdater/2.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                    WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) return false;
    WinHttpSetTimeouts(session, 10000, 10000, 30000, 180000);
    HINTERNET connect = WinHttpConnect(session, targetHost.c_str(), port, 0);
    if (!connect) { WinHttpCloseHandle(session); return false; }
    HINTERNET request = WinHttpOpenRequest(connect, L"GET", targetPath.c_str(), nullptr, WINHTTP_NO_REFERER,
                                            WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request) { WinHttpCloseHandle(connect); WinHttpCloseHandle(session); return false; }
    DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirects, sizeof(redirects));
    const wchar_t *headers = L"Accept: application/octet-stream,*/*\r\n";
    bool ok = WinHttpSendRequest(request, headers, (DWORD)-1L, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
              WinHttpReceiveResponse(request, nullptr);
    DWORD status = 0, statusSize = sizeof(status);
    if (ok) WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
    if (!ok || status != 200) {
      WinHttpCloseHandle(request); WinHttpCloseHandle(connect); WinHttpCloseHandle(session); return false;
    }

    std::ofstream output(targetFile, std::ios::binary | std::ios::trunc);
    if (!output.is_open()) {
      WinHttpCloseHandle(request); WinHttpCloseHandle(connect); WinHttpCloseHandle(session); return false;
    }
    char buffer[32768];
    DWORD read = 0;
    while (WinHttpReadData(request, buffer, sizeof(buffer), &read) && read > 0) output.write(buffer, read);
    output.close();
    WinHttpCloseHandle(request); WinHttpCloseHandle(connect); WinHttpCloseHandle(session);
    std::error_code ec;
    return fs::exists(targetFile, ec) && fs::file_size(targetFile, ec) > 500000;
  } catch (...) {
    return false;
  }
}

static bool downloadUpdateBinaryWithFallback(const std::wstring &url, const std::wstring &targetFile) {
  if (downloadUpdateBinaryFromUrl(url, targetFile)) return true;
  std::error_code ec;
  fs::remove(targetFile, ec);
  DeleteUrlCacheEntryW(url.c_str());
  const HRESULT result = URLDownloadToFileW(nullptr, url.c_str(), targetFile.c_str(),
                                             BINDF_GETNEWESTVERSION | BINDF_NOWRITECACHE, nullptr);
  return SUCCEEDED(result) && fs::exists(targetFile, ec) && !ec && fs::file_size(targetFile, ec) > 500000;
}

static bool parseUpdateManifest(const std::string &json, const std::wstring &filename,
                                const std::string &source, UpdatePackage &out) {
  const std::string version = trimUpdateText(extractJsonField(json, "version"));
  if (updateVersionNumber(version) < 0.0) return false;

  const std::string requested = toUtf8(filename);
  std::string objectKey = "\"" + requested + "\"";
  size_t entry = json.find(objectKey);
  if (entry == std::string::npos && requested != "DiscordUnlock.exe") {
    objectKey = "\"DiscordUnlock.exe\"";
    entry = json.find(objectKey);
  }
  if (entry == std::string::npos) return false;
  const size_t open = json.find('{', entry + objectKey.size());
  const size_t close = open == std::string::npos ? std::string::npos : json.find('}', open + 1);
  if (open == std::string::npos || close == std::string::npos) return false;

  const std::string artifact = json.substr(open, close - open + 1);
  const std::string url = trimUpdateText(extractJsonField(artifact, "url"));
  const std::string sha = trimUpdateText(extractJsonField(artifact, "sha256"));
  if (url.rfind("https://", 0) != 0 || !isSha256Value(sha)) return false;

  out.version = version;
  out.downloadUrl = url;
  out.sha256 = sha;
  out.source = source;
  return true;
}

static std::vector<UpdatePackage> getUpdatePackageCandidates(const std::wstring &filename) {
  std::vector<UpdatePackage> candidates;

  UpdatePackage cloud;
  const std::string cloudManifest = downloadUrl(CLOUD_API_HOST, L"/updates/update-manifest.json");
  if (parseUpdateManifest(cloudManifest, filename, "Cloudflare", cloud)) candidates.push_back(cloud);

  const std::wstring githubManifestUrl = configuredGithubReleaseManifestUrl();
  UpdatePackage github;
  if (!githubManifestUrl.empty()) {
    const std::string githubManifest = downloadTextFromFullUrl(githubManifestUrl);
    if (parseUpdateManifest(githubManifest, filename, "GitHub Releases", github)) candidates.push_back(github);
  }

  // Compatibility for existing Cloudflare publication until the first manifest is deployed.
  if (candidates.empty()) {
    const std::string legacyVersion = trimUpdateText(downloadUrl(CLOUD_API_HOST, L"/updates/version.txt"));
    const std::wstring requestedPath = L"/updates/" + filename;
    std::string legacyHash = trimUpdateText(downloadUrl(CLOUD_API_HOST, requestedPath + L".sha256"));
    std::wstring legacyFile = requestedPath;
    if (!isSha256Value(legacyHash) && filename != L"DiscordUnlock.exe") {
      legacyFile = L"/updates/DiscordUnlock.exe";
      legacyHash = trimUpdateText(downloadUrl(CLOUD_API_HOST, legacyFile + L".sha256"));
    }
    if (updateVersionNumber(legacyVersion) >= 0.0 && isSha256Value(legacyHash)) {
      candidates.push_back({legacyVersion, "https://discord-unlock-api.st4rs.workers.dev" + toUtf8(legacyFile),
                            legacyHash, "Cloudflare"});
    }
  }

  std::stable_sort(candidates.begin(), candidates.end(), [](const UpdatePackage &a, const UpdatePackage &b) {
    return updateVersionNumber(a.version) > updateVersionNumber(b.version);
  });
  return candidates;
}

std::string getLatestUpdateVersionFromAllSources() {
  const auto candidates = getUpdatePackageCandidates(fs::path(getCurrentExePath()).filename().wstring());
  return candidates.empty() ? "" : candidates.front().version;
}
