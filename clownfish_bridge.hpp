#pragma once

#include <windows.h>
#include <urlmon.h>
#include <tlhelp32.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#pragma comment(lib, "urlmon.lib")

namespace DiscordUnlock {

class ClownfishBridge {
public:
    static std::filesystem::path ExecutablePath() {
        std::vector<wchar_t*> roots = { _wgetenv(L"ProgramFiles(x86)"), _wgetenv(L"ProgramW6432"), _wgetenv(L"ProgramFiles") };
        for (const auto* root : roots) {
            if (!root || !*root) continue;
            const std::filesystem::path candidate = std::filesystem::path(root) / L"ClownfishVoiceChanger" / L"ClownfishVoiceChanger.exe";
            std::error_code ec;
            if (std::filesystem::exists(candidate, ec)) return candidate;
        }
        return {};
    }

    static HWND Window() {
        return FindWindowW(L"CLOWNFISHVOICECHANGER", L"Clownfish Voice Changer");
    }

    static bool IsInstalled() { return !ExecutablePath().empty(); }
    static bool IsRunning() { return Window() != nullptr; }

    static std::filesystem::path SettingsPath() {
        const auto* profile = _wgetenv(L"USERPROFILE");
        if (!profile || !*profile) return {};
        return std::filesystem::path(profile) / L"Documents" / L"ClownfishVoiceChanger.ini";
    }

    static bool Start(std::string& error) {
        // Clownfish initialises its audio service from its own UI process. Keep the compatible launcher,
        // but request a non-activating minimized state so it does not take focus from the user.
        if (Window()) return true;

        const auto executable = ExecutablePath();
        if (executable.empty()) { error = "Clownfish nao esta instalado."; return false; }
        const auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", executable.c_str(), nullptr, nullptr, SW_SHOWMINNOACTIVE));
        if (result <= 32) { error = "Nao foi possivel iniciar o Clownfish."; return false; }
        for (int i = 0; i < 40 && !Window(); ++i) Sleep(100);
        if (!Window()) { error = "O Clownfish iniciou, mas a integracao de audio ainda nao ficou pronta."; return false; }
        return true;
    }
    static bool Send(const std::string& command, std::string& error) {
        HWND window = Window();
        if (!window) {
            if (IsInstalled()) Start(error);
            window = Window();
        }
        if (!window) { if (error.empty()) error = "Abra o Clownfish e conclua a integracao com o microfone."; return false; }
        COPYDATASTRUCT payload{};
        payload.dwData = 42;
        payload.cbData = static_cast<DWORD>(command.size());
        payload.lpData = const_cast<char*>(command.data());
        DWORD_PTR response = 0;
        if (!SendMessageTimeoutW(window, WM_COPYDATA, 0, reinterpret_cast<LPARAM>(&payload), SMTO_ABORTIFHUNG, 2000, &response)) {
            const DWORD code = GetLastError();
            error = code == ERROR_ACCESS_DENIED
                ? "O Windows bloqueou a comunicacao com o Clownfish por diferenca de permissao. Abra o Unlock e o Clownfish com o mesmo nivel de permissao."
                : "O Clownfish nao respondeu ao comando (erro " + std::to_string(code) + "). Reinicie o motor e tente novamente.";
            return false;
        }
        return true;
    }

    // The API changes the live player volume, while its INI controls the value
    // restored at startup. Keep both synchronized so a stale zero cannot mute
    // the Soundpad after a restart.
    static bool SetSoundboardVolume(int percent, std::string& error, bool* correctedMutedVolume = nullptr) {
        percent = (std::max)(0, (std::min)(100, percent));
        if (correctedMutedVolume) *correctedMutedVolume = false;
        if (!Start(error)) return false;

        const auto settings = SettingsPath();
        if (!settings.empty()) {
            std::ifstream input(settings);
            std::string line, rebuilt;
            int previous = -1;
            bool found = false;
            while (std::getline(input, line)) {
                if (line.rfind("MUSIC_VOLUME=", 0) == 0) {
                    try { previous = std::stoi(line.substr(13)); } catch (...) {}
                    line = "MUSIC_VOLUME=" + std::to_string(percent);
                    found = true;
                }
                rebuilt += line + "\r\n";
            }
            if (!found) rebuilt += "MUSIC_VOLUME=" + std::to_string(percent) + "\r\n";
            if (correctedMutedVolume && previous == 0 && percent > 0) *correctedMutedVolume = true;
            const auto temporary = settings.wstring() + L".unlock.tmp";
            std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
            if (output.is_open()) {
                output.write(rebuilt.data(), static_cast<std::streamsize>(rebuilt.size()));
                output.close();
                MoveFileExW(temporary.c_str(), settings.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
            }
        }
        return Send("5|" + std::to_string(percent), error);
    }
    // Restarts only the official audio engine when it is installed but stopped
    // responding. This never touches Discord or a microphone driver.
    static bool Restart(std::string& error) {
        const auto executable = ExecutablePath();
        if (executable.empty()) { error = "Clownfish nao esta instalado."; return false; }

        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W entry{};
            entry.dwSize = sizeof(entry);
            if (Process32FirstW(snapshot, &entry)) {
                do {
                    if (_wcsicmp(entry.szExeFile, L"ClownfishVoiceChanger.exe") != 0) continue;
                    HANDLE process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, entry.th32ProcessID);
                    if (!process) {
                        CloseHandle(snapshot);
                        error = "O Clownfish usa permissao diferente. Abra o Unlock como administrador para reparar o motor.";
                        return false;
                    }
                    TerminateProcess(process, 0);
                    WaitForSingleObject(process, 2500);
                    CloseHandle(process);
                } while (Process32NextW(snapshot, &entry));
            }
            CloseHandle(snapshot);
        }
        Sleep(500);
        return Start(error);
    }

    // Used by the Soundpad startup and before every playback. It deliberately
    // skips every check when the user has never installed Clownfish.
    static bool EnsureSoundboardReady(int percent, bool resetVoiceEffects, std::string& error,
                                      bool* correctedMutedVolume = nullptr, bool* restartedEngine = nullptr) {
        percent = (std::max)(0, (std::min)(100, percent));
        if (correctedMutedVolume) *correctedMutedVolume = false;
        if (restartedEngine) *restartedEngine = false;
        if (!IsInstalled()) return true;

        auto apply = [&](bool* muted) {
            if (!Start(error)) return false;
            if (resetVoiceEffects && !Send("3|0", error)) return false;
            if (!Send("2|1", error)) return false;
            return SetSoundboardVolume(percent, error, muted);
        };

        bool corrected = false;
        if (apply(&corrected)) {
            if (correctedMutedVolume) *correctedMutedVolume = corrected;
            return true;
        }

        const std::string firstError = error;
        // A different UAC level cannot be bypassed silently. The main app is
        // normally elevated, so a restart repairs ordinary hangs automatically.
        if (firstError.find("diferenca de permissao") != std::string::npos ||
            firstError.find("acesso negado") != std::string::npos) {
            error = firstError;
            return false;
        }

        error.clear();
        if (!Restart(error)) {
            if (error.empty()) error = firstError;
            return false;
        }
        if (restartedEngine) *restartedEngine = true;
        corrected = false;
        if (!apply(&corrected)) return false;
        if (correctedMutedVolume) *correctedMutedVolume = corrected;
        return true;
    }

    // Windows stores the filter identity either in the value name or inside a
    // string/binary FxProperties value, depending on the audio driver. The
    // original check only looked at names and could report a false negative.
    static bool ContainsClownfishMarker(const BYTE* data, DWORD dataSize) {
        if (!data || dataSize == 0) return false;
        auto containsLower = [](const std::wstring& text) {
            std::wstring lower = text;
            std::transform(lower.begin(), lower.end(), lower.begin(), ::towlower);
            return lower.find(L"clownfish") != std::wstring::npos;
        };
        if (dataSize >= sizeof(wchar_t) && containsLower(std::wstring(
                reinterpret_cast<const wchar_t*>(data), dataSize / sizeof(wchar_t)))) return true;
        std::string ascii(reinterpret_cast<const char*>(data), dataSize);
        std::transform(ascii.begin(), ascii.end(), ascii.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return ascii.find("clownfish") != std::string::npos;
    }

    static bool HasAudioFilterAttached() {
        HKEY root = nullptr;
        if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture", 0, KEY_READ, &root) != ERROR_SUCCESS) return false;
        bool attached = false;
        for (DWORD index = 0; !attached; ++index) {
            wchar_t endpoint[256]{};
            DWORD endpointLen = static_cast<DWORD>(std::size(endpoint));
            if (RegEnumKeyExW(root, index, endpoint, &endpointLen, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
            HKEY fx = nullptr;
            const std::wstring path = std::wstring(endpoint, endpointLen) + L"\\FxProperties";
            if (RegOpenKeyExW(root, path.c_str(), 0, KEY_READ, &fx) != ERROR_SUCCESS) continue;
            for (DWORD valueIndex = 0; ; ++valueIndex) {
                wchar_t valueName[512]{};
                DWORD valueLen = static_cast<DWORD>(std::size(valueName));
                const LONG result = RegEnumValueW(fx, valueIndex, valueName, &valueLen, nullptr, nullptr, nullptr, nullptr);
                if (result == ERROR_NO_MORE_ITEMS) break;
                if (result != ERROR_SUCCESS) continue;
                std::wstring lower(valueName, valueLen);
                std::transform(lower.begin(), lower.end(), lower.begin(), ::towlower);
                if (lower.find(L"clownfish") != std::wstring::npos) { attached = true; break; }

                DWORD type = 0;
                DWORD dataSize = 0;
                if (RegQueryValueExW(fx, valueName, nullptr, &type, nullptr, &dataSize) == ERROR_SUCCESS && dataSize > 0) {
                    std::vector<BYTE> data(dataSize);
                    if (RegQueryValueExW(fx, valueName, nullptr, &type, data.data(), &dataSize) == ERROR_SUCCESS &&
                        ContainsClownfishMarker(data.data(), dataSize)) {
                        attached = true;
                        break;
                    }
                }
            }
            RegCloseKey(fx);
        }
        RegCloseKey(root);
        return attached;
    }

    // Driver attachment belongs to Clownfish's administrator-protected Setup.
    // This repairs the engine and opens that official Setup path when Windows
    // still requires the user to select a physical capture device. It never
    // changes Discord's default microphone.
    static bool AutoRepair(std::string& error, bool* needsSetup = nullptr, bool* restarted = nullptr) {
        if (needsSetup) *needsSetup = false;
        if (restarted) *restarted = false;
        if (!IsInstalled()) {
            error = "Clownfish nao esta instalado. Use Instalar oficial primeiro.";
            return false;
        }

        std::string startError;
        if (!Start(startError)) {
            if (!Restart(startError)) {
                error = startError;
                return false;
            }
            if (restarted) *restarted = true;
        }
        if (HasAudioFilterAttached()) return true;

        const auto executable = ExecutablePath();
        const auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"runas", executable.c_str(), nullptr,
                                                                       executable.parent_path().c_str(), SW_SHOWNORMAL));
        if (result <= 32) {
            error = "O filtro ainda nao esta ligado ao microfone e o Windows bloqueou a abertura administrativa do Clownfish.";
            return false;
        }
        if (needsSetup) *needsSetup = true;
        error = "O Clownfish foi aberto como administrador. No icone dele perto do relogio, abra Setup, selecione o microfone fisico e clique Install. O Discord deve continuar usando esse mesmo microfone.";
        return false;
    }
    // A legacy endpoint may return an HTML/PHP error page while keeping the
    // .exe name. Never pass that content to Windows ShellExecute.
    static bool IsSupportedWindowsInstaller(const std::filesystem::path& file, std::string& error) {
        std::error_code ec;
        const auto size = std::filesystem::file_size(file, ec);
        if (ec || size < 128 * 1024) {
            error = "O download do Clownfish esta incompleto ou nao e um instalador valido.";
            return false;
        }

        std::ifstream input(file, std::ios::binary);
        WORD mz = 0;
        DWORD peOffset = 0;
        if (!input.read(reinterpret_cast<char*>(&mz), sizeof(mz)) || mz != IMAGE_DOS_SIGNATURE ||
            !input.seekg(0x3c, std::ios::beg).read(reinterpret_cast<char*>(&peOffset), sizeof(peOffset)) ||
            peOffset < 0x40 || peOffset > size - 6) {
            error = "O download do Clownfish nao possui uma estrutura de instalador do Windows valida.";
            return false;
        }

        DWORD signature = 0;
        WORD machine = 0;
        if (!input.seekg(peOffset, std::ios::beg).read(reinterpret_cast<char*>(&signature), sizeof(signature)) ||
            !input.read(reinterpret_cast<char*>(&machine), sizeof(machine)) || signature != IMAGE_NT_SIGNATURE ||
            (machine != IMAGE_FILE_MACHINE_I386 && machine != IMAGE_FILE_MACHINE_AMD64)) {
            error = "O download do Clownfish nao e compativel com este Windows.";
            return false;
        }
        return true;
    }

    static bool InstallOfficial(std::string& error) {
        const auto setupDir = std::filesystem::temp_directory_path() / L"DiscordUnlockClownfishTest";
        std::error_code ec;
        std::filesystem::create_directories(setupDir, ec);
        const auto installer = setupDir / L"ClownfishVoiceChanger-2.05-setup.exe";
        const auto download = setupDir / L"ClownfishVoiceChanger-2.05-setup.download";
        // The stable official 64-bit package. The former 64f endpoint currently
        // returns a PHP error page instead of an executable.
        constexpr const wchar_t* officialUrl = L"https://www.clownfish-translator.com/voicechanger/download/download64.php?v=205";
        std::filesystem::remove(installer, ec);
        std::filesystem::remove(download, ec);
        if (FAILED(URLDownloadToFileW(nullptr, officialUrl, download.c_str(), 0, nullptr))) {
            error = "Falha ao baixar o instalador oficial do Clownfish.";
            return false;
        }
        if (!IsSupportedWindowsInstaller(download, error)) {
            std::filesystem::remove(download, ec);
            return false;
        }
        std::filesystem::rename(download, installer, ec);
        if (ec) {
            error = "Nao foi possivel preparar o instalador oficial do Clownfish.";
            return false;
        }
        const auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"runas", installer.c_str(), nullptr, setupDir.c_str(), SW_SHOWNORMAL));
        if (result <= 32) { error = "O Windows cancelou ou bloqueou o instalador do Clownfish."; return false; }
        return true;
    }

    // The audio integration is owned by the official Clownfish installer. Do
    // not touch device drivers directly: hand removal back to its uninstaller
    // so it can restore each microphone endpoint it changed.
    static bool UninstallOfficial(std::string& error) {
        const auto executable = ExecutablePath();
        if (executable.empty()) { error = "A integracao de audio nao esta instalada."; return false; }
        const auto uninstaller = executable.parent_path() / L"uninstall.exe";
        std::error_code ec;
        if (!std::filesystem::exists(uninstaller, ec)) {
            error = "O desinstalador oficial da integracao de audio nao foi encontrado.";
            return false;
        }
        const auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"runas", uninstaller.c_str(), nullptr,
                                                                       executable.parent_path().c_str(), SW_SHOWNORMAL));
        if (result <= 32) { error = "O Windows cancelou ou bloqueou o desinstalador da integracao de audio."; return false; }
        return true;
    }
};

} // namespace DiscordUnlock
