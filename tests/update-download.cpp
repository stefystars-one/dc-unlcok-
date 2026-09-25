#include <windows.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;

static bool downloadUpdateBinaryFromUrl(const std::wstring &url, const std::wstring &targetFile) {
  URL_COMPONENTS components = {0};
  components.dwStructSize = sizeof(components);
  wchar_t host[512] = {0}, path[4096] = {0}, extra[4096] = {0};
  components.lpszHostName = host; components.dwHostNameLength = 511;
  components.lpszUrlPath = path; components.dwUrlPathLength = 4095;
  components.lpszExtraInfo = extra; components.dwExtraInfoLength = 4095;
  if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &components)) return false;
  const std::wstring targetHost(components.lpszHostName, components.dwHostNameLength);
  const std::wstring targetPath = std::wstring(components.lpszUrlPath, components.dwUrlPathLength) + std::wstring(components.lpszExtraInfo, components.dwExtraInfoLength);
  const INTERNET_PORT port = components.nPort ? components.nPort : INTERNET_DEFAULT_HTTPS_PORT;
  HINTERNET session = WinHttpOpen(L"DiscordUnlockUpdater/2.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) return false;
  WinHttpSetTimeouts(session, 10000, 10000, 30000, 180000);
  HINTERNET connect = WinHttpConnect(session, targetHost.c_str(), port, 0);
  HINTERNET request = connect ? WinHttpOpenRequest(connect, L"GET", targetPath.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr;
  DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
  if (request) WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirects, sizeof(redirects));
  const wchar_t *headers = L"Accept: application/octet-stream,*/*\r\n";
  bool ok = request && WinHttpSendRequest(request, headers, static_cast<DWORD>(-1L), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(request, nullptr);
  DWORD status = 0, statusSize = sizeof(status);
  if (ok) WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
  std::ofstream output;
  if (ok && status == 200) output.open(targetFile, std::ios::binary | std::ios::trunc);
  char buffer[32768]; DWORD read = 0;
  while (output.is_open() && WinHttpReadData(request, buffer, sizeof(buffer), &read) && read > 0) output.write(buffer, read);
  output.close();
  if (request) WinHttpCloseHandle(request); if (connect) WinHttpCloseHandle(connect); WinHttpCloseHandle(session);
  std::error_code ec;
  std::wcout << L"status=" << status << L" error=" << GetLastError() << L"\n";
  return fs::exists(targetFile, ec) && fs::file_size(targetFile, ec) > 500000;
}

static std::string sha256(const std::wstring &filePath) {
  HCRYPTPROV provider = 0; HCRYPTHASH hashHandle = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) || !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hashHandle)) return {};
  HANDLE file = CreateFileW(filePath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (file == INVALID_HANDLE_VALUE) return {};
  BYTE buffer[16384]; DWORD bytesRead = 0;
  while (ReadFile(file, buffer, sizeof(buffer), &bytesRead, nullptr) && bytesRead > 0) CryptHashData(hashHandle, buffer, bytesRead, 0);
  CloseHandle(file); BYTE value[32]; DWORD size = sizeof(value); std::ostringstream result;
  if (CryptGetHashParam(hashHandle, HP_HASHVAL, value, &size, 0)) for (DWORD i=0;i<size;i++) result << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(value[i]);
  CryptDestroyHash(hashHandle); CryptReleaseContext(provider, 0); return result.str();
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 3) return 2;
  if (!downloadUpdateBinaryFromUrl(argv[1], argv[2])) return 3;
  std::cout << "sha256=" << sha256(argv[2]) << "\n";
  return 0;
}
