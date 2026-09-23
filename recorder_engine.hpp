#pragma once

#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <codecapi.h>

#include <string>
#include <vector>
#include <deque>
#include <thread>
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <filesystem>
#include <memory>
#include <functional>
#include <sstream>
#include <iomanip>
#include <algorithm>

#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "avrt.lib")

namespace fs = std::filesystem;

namespace DiscordUnlock {

struct MonitorTargetInfo {
    int index = 0;
    std::string name;
    std::string deviceName;
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
    int orientation = 0; // 0 = 0 deg, 1 = 90 deg, 2 = 180 deg, 3 = 270 deg
    bool isPrimary = false;
};

struct MonitorEnumData {
    std::vector<MonitorTargetInfo> list;
    int count = 0;
};

inline std::vector<MonitorTargetInfo> GetSystemMonitors() {
    MonitorEnumData data;
    EnumDisplayMonitors(NULL, NULL, [](HMONITOR hMon, HDC hdc, LPRECT lprc, LPARAM dwData) -> BOOL {
        auto* pData = reinterpret_cast<MonitorEnumData*>(dwData);
        MONITORINFOEXW mi;
        mi.cbSize = sizeof(mi);
        if (GetMonitorInfoW(hMon, &mi)) {
            MonitorTargetInfo m;
            m.index = pData->count++;
            m.x = mi.rcMonitor.left;
            m.y = mi.rcMonitor.top;
            m.width = mi.rcMonitor.right - mi.rcMonitor.left;
            m.height = mi.rcMonitor.bottom - mi.rcMonitor.top;
            m.isPrimary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;
            
            char devName[64] = {0};
            WideCharToMultiByte(CP_UTF8, 0, mi.szDevice, -1, devName, sizeof(devName), NULL, NULL);
            m.deviceName = devName;

            DEVMODEW dm = {0};
            dm.dmSize = sizeof(dm);
            if (EnumDisplaySettingsW(mi.szDevice, ENUM_CURRENT_SETTINGS, &dm)) {
                m.orientation = dm.dmDisplayOrientation;
            }

            std::stringstream ss;
            ss << "Monitor " << (m.index + 1) << (m.isPrimary ? " (Principal)" : "")
               << " - " << m.width << "x" << m.height;
            if (m.orientation == 2) {
                ss << " [180Â° Invertido]";
            }
            m.name = ss.str();

            pData->list.push_back(m);
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&data));

    return data.list;
}

struct RecorderSettings {
    std::wstring outputFolder = L"";
    std::string resolutionMode = "1080p60"; // "native", "1440p60", "1080p60", "720p60"
    int targetWidth = 1920;
    int targetHeight = 1080;
    int fps = 60;
    int bitrate = 20000000; // 20 Mbps Gamer
    std::string captureTarget = "monitor"; // "monitor" or "window"
    int monitorIndex = 0;
    HWND targetHwnd = nullptr;
    std::string targetWindowName = "";
    std::string audioMode = "pc"; // "pc" or "game"
    bool recordMic = false;
    std::wstring micDeviceId = L"";
    bool flip180 = false;
    // "hidden", "cursor" ou "highlight". Vale tanto para a gravação manual
    // quanto para os segmentos usados pelo Replay Instantâneo.
    std::string cursorMode = "hidden";
    bool replayBufferEnabled = false;
    int replayBufferSeconds = 30; // 15, 30, 60, 120, 180, 300
    std::string replayQuality = "economy"; // economy, balanced, high
    bool autoUploadCloud = false;
    bool autoUploadDeleteLocal = false;
    int hotkeyRecordMod = MOD_CONTROL;
    int hotkeyRecordKey = VK_F9;
    int hotkeyClipMod = MOD_CONTROL;
    int hotkeyClipKey = VK_F10;
};

struct ClipInfo {
    std::string id;
    std::string filename;
    std::wstring filepath;
    double sizeMb = 0.0;
    int durationSec = 0;
    std::string createdAt;
    std::string cloudUrl = "";
    bool isUploading = false;
};

// Captura por DXGI Desktop Duplication. É a mesma família de API usada pelos
// capturadores modernos do Windows; evita a cópia GDI/BitBlt por quadro.
class DesktopDuplicationCapture {
public:
    ~DesktopDuplicationCapture() { Shutdown(); }

    bool Initialize(int monitorIndex) {
        Shutdown();
        const auto monitors = GetSystemMonitors();
        std::wstring wantedDevice;
        if (monitorIndex >= 0 && monitorIndex < static_cast<int>(monitors.size())) wantedDevice.assign(monitors[monitorIndex].deviceName.begin(), monitors[monitorIndex].deviceName.end());

        IDXGIFactory1* factory = nullptr;
        if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory))) || !factory) return false;
        IDXGIAdapter1* chosenAdapter = nullptr;
        IDXGIOutput* chosenOutput = nullptr;
        for (UINT adapterIndex = 0; !chosenOutput; ++adapterIndex) {
            IDXGIAdapter1* adapter = nullptr;
            if (factory->EnumAdapters1(adapterIndex, &adapter) != S_OK || !adapter) break;
            for (UINT outputIndex = 0; ; ++outputIndex) {
                IDXGIOutput* output = nullptr;
                if (adapter->EnumOutputs(outputIndex, &output) != S_OK || !output) break;
                DXGI_OUTPUT_DESC outDesc = {};
                output->GetDesc(&outDesc);
                if (wantedDevice.empty() || wantedDevice == outDesc.DeviceName) {
                    chosenAdapter = adapter;
                    chosenAdapter->AddRef();
                    chosenOutput = output;
                    break;
                }
                output->Release();
            }
            adapter->Release();
        }
        factory->Release();
        if (!chosenAdapter || !chosenOutput) { if (chosenAdapter) chosenAdapter->Release(); return false; }

        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        D3D_FEATURE_LEVEL level;
        HRESULT hr = D3D11CreateDevice(chosenAdapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, nullptr, 0,
                                       D3D11_SDK_VERSION, &device_, &level, &context_);
        chosenAdapter->Release();
        if (FAILED(hr) || !device_ || !context_) { chosenOutput->Release(); Shutdown(); return false; }

        IDXGIOutput1* output1 = nullptr;
        hr = chosenOutput->QueryInterface(__uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1));
        chosenOutput->Release();
        if (FAILED(hr) || !output1) { Shutdown(); return false; }
        hr = output1->DuplicateOutput(device_, &duplication_);
        output1->Release();
        if (FAILED(hr) || !duplication_) { Shutdown(); return false; }
        ready_ = true;
        return true;
    }

    bool CopyFrame(BYTE* destination, int destWidth, int destHeight) {
        if (!ready_ || !destination || destWidth <= 0 || destHeight <= 0) return false;
        DXGI_OUTDUPL_FRAME_INFO frameInfo = {};
        IDXGIResource* resource = nullptr;
        HRESULT hr = duplication_->AcquireNextFrame(5, &frameInfo, &resource);
        // Sem quadro novo, reutilize o último frame em vez de voltar ao BitBlt.
        if (hr == DXGI_ERROR_WAIT_TIMEOUT) return hasFrame_;
        if (hr == DXGI_ERROR_ACCESS_LOST) { Shutdown(); return false; }
        if (FAILED(hr) || !resource) return false;

        ID3D11Texture2D* source = nullptr;
        hr = resource->QueryInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&source));
        resource->Release();
        if (FAILED(hr) || !source) { duplication_->ReleaseFrame(); return false; }
        D3D11_TEXTURE2D_DESC desc = {};
        source->GetDesc(&desc);
        if (!staging_ || sourceWidth_ != static_cast<int>(desc.Width) || sourceHeight_ != static_cast<int>(desc.Height) || sourceFormat_ != desc.Format) {
            if (staging_) { staging_->Release(); staging_ = nullptr; }
            D3D11_TEXTURE2D_DESC stagingDesc = desc;
            stagingDesc.BindFlags = 0;
            stagingDesc.MiscFlags = 0;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            if (FAILED(device_->CreateTexture2D(&stagingDesc, nullptr, &staging_))) { source->Release(); duplication_->ReleaseFrame(); return false; }
            sourceWidth_ = static_cast<int>(desc.Width); sourceHeight_ = static_cast<int>(desc.Height); sourceFormat_ = desc.Format;
        }
        context_->CopyResource(staging_, source);
        source->Release();
        D3D11_MAPPED_SUBRESOURCE mapped = {};
        hr = context_->Map(staging_, 0, D3D11_MAP_READ, 0, &mapped);
        if (SUCCEEDED(hr)) {
            const BYTE* sourceBytes = static_cast<const BYTE*>(mapped.pData);
            if (sourceWidth_ == destWidth && sourceHeight_ == destHeight) {
                for (int y = 0; y < destHeight; ++y) memcpy(destination + static_cast<size_t>(destHeight - 1 - y) * destWidth * 4, sourceBytes + static_cast<size_t>(y) * mapped.RowPitch, static_cast<size_t>(destWidth) * 4);
            } else {
                for (int y = 0; y < destHeight; ++y) {
                    const int sy = (std::min)(sourceHeight_ - 1, y * sourceHeight_ / destHeight);
                    const uint32_t* srcRow = reinterpret_cast<const uint32_t*>(sourceBytes + static_cast<size_t>(sy) * mapped.RowPitch);
                    uint32_t* dstRow = reinterpret_cast<uint32_t*>(destination + static_cast<size_t>(destHeight - 1 - y) * destWidth * 4);
                    for (int x = 0; x < destWidth; ++x) dstRow[x] = srcRow[(std::min)(sourceWidth_ - 1, x * sourceWidth_ / destWidth)];
                }
            }
            context_->Unmap(staging_, 0);
            duplication_->ReleaseFrame();
            hasFrame_ = true;
            return true;
        }
        duplication_->ReleaseFrame();
        return false;
    }

    void Shutdown() {
        ready_ = false;
        if (staging_) { staging_->Release(); staging_ = nullptr; }
        if (duplication_) { duplication_->Release(); duplication_ = nullptr; }
        if (context_) { context_->Release(); context_ = nullptr; }
        if (device_) { device_->Release(); device_ = nullptr; }
        sourceWidth_ = sourceHeight_ = 0;
        hasFrame_ = false;
    }
private:
    ID3D11Device* device_ = nullptr;
    ID3D11DeviceContext* context_ = nullptr;
    IDXGIOutputDuplication* duplication_ = nullptr;
    ID3D11Texture2D* staging_ = nullptr;
    DXGI_FORMAT sourceFormat_ = DXGI_FORMAT_UNKNOWN;
    int sourceWidth_ = 0, sourceHeight_ = 0;
    bool ready_ = false;
    bool hasFrame_ = false;
};
class ScreenRecorder {
public:
    static ScreenRecorder& Instance() {
        static ScreenRecorder instance;
        return instance;
    }

    ScreenRecorder() {
        // Obter pasta padrao de videos: %USERPROFILE%\Videos\DiscordUnlock
        wchar_t userProfile[MAX_PATH] = {0};
        if (GetEnvironmentVariableW(L"USERPROFILE", userProfile, MAX_PATH) > 0) {
            fs::path p = fs::path(userProfile) / L"Videos" / L"DiscordUnlock";
            settings.outputFolder = p.wstring();
            std::error_code ec;
            fs::create_directories(p, ec);
        }
        
        // Pasta temp para replay buffer
        wchar_t tempPath[MAX_PATH] = {0};
        GetTempPathW(MAX_PATH, tempPath);
        bufferFolder = fs::path(tempPath) / L"DiscordUnlock_Buffer";
        std::error_code ec;
        fs::create_directories(bufferFolder, ec);
    }

    ~ScreenRecorder() {
        StopRecording();
        StopReplayBuffer();
    }

    RecorderSettings GetSettings() const {
        std::lock_guard<std::mutex> lock(stateMutex);
        return settings;
    }

    void UpdateSettings(const RecorderSettings& newSettings) {
        std::lock_guard<std::mutex> lock(stateMutex);
        settings = newSettings;
        if (!settings.outputFolder.empty()) {
            std::error_code ec;
            fs::create_directories(settings.outputFolder, ec);
        }
    }

    bool IsRecording() const { return isRecording.load(); }
    bool IsReplayBufferActive() const { return isReplayBufferActive.load(); }

    int GetRecordingDurationSec() const {
        if (!isRecording.load()) return 0;
        auto now = std::chrono::steady_clock::now();
        return (int)std::chrono::duration_cast<std::chrono::seconds>(now - recordingStartTime).count();
    }

    // Iniciar Gravacao Manual
    bool StartRecording(std::string& outError) {
        std::lock_guard<std::mutex> lock(opMutex);
        if (isRecording.load()) {
            outError = "Gravacao ja em andamento.";
            return false;
        }

        RecorderSettings captureSettings;
        {
            std::lock_guard<std::mutex> stateLock(stateMutex);
            captureSettings = settings;
        }
        std::error_code ec;
        fs::create_directories(captureSettings.outputFolder, ec);

        auto now = std::chrono::system_clock::now();
        std::time_t tt = std::chrono::system_clock::to_time_t(now);
        std::tm tm;
        localtime_s(&tm, &tt);

        std::wstringstream wss;
        wss << L"Gravacao_" 
            << std::setfill(L'0') << std::setw(4) << (tm.tm_year + 1900) << L"-"
            << std::setfill(L'0') << std::setw(2) << (tm.tm_mon + 1) << L"-"
            << std::setfill(L'0') << std::setw(2) << tm.tm_mday << L"_"
            << std::setfill(L'0') << std::setw(2) << tm.tm_hour << L"-"
            << std::setfill(L'0') << std::setw(2) << tm.tm_min << L"-"
            << std::setfill(L'0') << std::setw(2) << tm.tm_sec << L".mp4";

        currentFile = (fs::path(captureSettings.outputFolder) / wss.str()).wstring();

        stopRequested.store(false);
        isRecording.store(true);
        recordingStartTime = std::chrono::steady_clock::now();

        workerThread = std::thread(&ScreenRecorder::RecordingWorker, this, currentFile, 0, false, captureSettings);
        return true;
    }

    // Parar Gravacao Manual
    bool StopRecording(std::wstring* outSavedFile = nullptr) {
        std::lock_guard<std::mutex> lock(opMutex);
        if (!isRecording.load()) return false;

        stopRequested.store(true);
        if (workerThread.joinable()) {
            workerThread.join();
        }
        isRecording.store(false);

        std::error_code ec;
        const bool validFile = !currentFile.empty() && fs::exists(currentFile, ec) &&
                               fs::is_regular_file(currentFile, ec) && fs::file_size(currentFile, ec) > 4096;
        if (!validFile) {
            if (!currentFile.empty()) fs::remove(currentFile, ec);
            if (outSavedFile) outSavedFile->clear();
            return false;
        }

        if (outSavedFile) *outSavedFile = currentFile;
        return true;
    }

    // Iniciar Buffer de Clipes (Replay Buffer continuo)
    bool StartReplayBuffer(std::string& outError) {
        std::lock_guard<std::mutex> lock(opMutex);
        if (isReplayBufferActive.load()) return true;

        bufferStopRequested.store(false);
        {
            std::lock_guard<std::mutex> segmentsLock(bufferSegmentsMutex);
            bufferSegments.clear();
            activeBufferSegment.clear();
        }
        isReplayBufferActive.store(true);

        bufferThread = std::thread(&ScreenRecorder::ReplayBufferWorker, this);
        return true;
    }

    // Parar Buffer de Clipes
    void StopReplayBuffer() {
        std::lock_guard<std::mutex> lock(opMutex);
        if (!isReplayBufferActive.load()) return;

        bufferStopRequested.store(true);
        if (bufferThread.joinable()) {
            bufferThread.join();
        }
        isReplayBufferActive.store(false);
    }

    // Salva o último trecho pronto. Se o primeiro segmento ainda estiver sendo
    // gravado, ele é finalizado e exportado como clipe parcial em vez de perdido.
    bool SaveClipFromBuffer(std::wstring& outClipPath, std::string& outError) {
        std::lock_guard<std::mutex> lock(clipMutex);

        RecorderSettings captureSettings;
        {
            std::lock_guard<std::mutex> stateLock(stateMutex);
            captureSettings = settings;
        }
        std::error_code ec;
        fs::create_directories(captureSettings.outputFolder, ec);

        auto now = std::chrono::system_clock::now();
        std::time_t tt = std::chrono::system_clock::to_time_t(now);
        std::tm tm;
        localtime_s(&tm, &tt);
        std::wstringstream wss;
        wss << L"Clipe_"
            << std::setfill(L'0') << std::setw(4) << (tm.tm_year + 1900) << L"-"
            << std::setfill(L'0') << std::setw(2) << (tm.tm_mon + 1) << L"-"
            << std::setfill(L'0') << std::setw(2) << tm.tm_mday << L"_"
            << std::setfill(L'0') << std::setw(2) << tm.tm_hour << L"-"
            << std::setfill(L'0') << std::setw(2) << tm.tm_min << L"-"
            << std::setfill(L'0') << std::setw(2) << tm.tm_sec << L".mp4";
        outClipPath = (fs::path(captureSettings.outputFolder) / wss.str()).wstring();

        std::wstring segmentToSave = GetLatestBufferSegment();
        const bool needsPartialExport = segmentToSave.empty() && isReplayBufferActive.load();
        if (needsPartialExport) {
            // MP4 só se torna copiável depois de Finalize(). Paramos somente o
            // segmento em andamento, salvamos o que já existe e retomamos o buffer.
            StopReplayBuffer();
            segmentToSave = GetActiveBufferSegment();
        }

        const bool hasData = !segmentToSave.empty() && fs::exists(segmentToSave, ec) &&
                             fs::is_regular_file(segmentToSave, ec) && fs::file_size(segmentToSave, ec) > 4096;
        bool copied = false;
        if (hasData) {
            try {
                fs::copy_file(segmentToSave, outClipPath, fs::copy_options::overwrite_existing);
                copied = true;
            } catch (...) {
                outError = "Erro ao exportar clipe do buffer.";
            }
        } else {
            outError = "O buffer ainda não recebeu dados de vídeo. Aguarde alguns instantes e tente novamente.";
        }

        if (needsPartialExport) {
            std::string restartError;
            StartReplayBuffer(restartError);
        }
        return copied;
    }
    // Lista todos os clipes e gravacoes salvos
    std::vector<ClipInfo> GetClips() {
        std::vector<ClipInfo> clips;
        std::error_code ec;
        if (!fs::exists(settings.outputFolder, ec)) return clips;

        for (const auto& entry : fs::directory_iterator(settings.outputFolder, ec)) {
            if (entry.is_regular_file() && entry.path().extension() == L".mp4") {
                ClipInfo ci;
                ci.filename = entry.path().filename().string();
                ci.filepath = entry.path().wstring();
                ci.id = entry.path().stem().string();
                
                auto fsize = entry.file_size(ec);
                // Arquivos pequenos assim nao possuem um MP4 finalizado. Oculte
                // restos de falhas anteriores para que nao aparecam como videos.
                if (ec || fsize <= 4096) continue;
                ci.sizeMb = (double)fsize / (1024.0 * 1024.0);

                // Data de criacao / modificacao
                auto ftime = entry.last_write_time(ec);
                auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
                    ftime - fs::file_time_type::clock::now() + std::chrono::system_clock::now()
                );
                std::time_t cftime = std::chrono::system_clock::to_time_t(sctp);
                std::tm ltm;
                localtime_s(&ltm, &cftime);

                char timeBuf[64];
                strftime(timeBuf, sizeof(timeBuf), "%d/%m/%Y %H:%M", &ltm);
                ci.createdAt = timeBuf;

                // Estimar duracao aproximada pelo tamanho e bitrate padrao (~6Mbps)
                if (ci.sizeMb > 0) {
                    ci.durationSec = (int)((ci.sizeMb * 8.0 * 1024.0 * 1024.0) / (double)settings.bitrate);
                    if (ci.durationSec <= 0) ci.durationSec = 1;
                }

                clips.push_back(ci);
            }
        }

        // Ordenar mais recentes primeiro
        std::sort(clips.begin(), clips.end(), [](const ClipInfo& a, const ClipInfo& b) {
            return a.filename > b.filename;
        });

        return clips;
    }

    bool DeleteClip(const std::wstring& filePath) {
        std::error_code ec;
        return fs::remove(filePath, ec);
    }
    // Corte rápido: remuxa vídeo e áudio sem reencodar. O início acompanha o keyframe disponível.
    // Suporta rotação orientada sem perda de qualidade (0, 90, 180, 270 graus).
    bool TrimClip(const std::wstring& sourcePath, double startSec, double endSec, std::wstring& outClipPath, std::string& outError) {
        return TrimClip(sourcePath, startSec, endSec, 0, outClipPath, outError);
    }

    bool TrimClip(const std::wstring& sourcePath, double startSec, double endSec, int rotationDegrees, std::wstring& outClipPath, std::string& outError) {
        outClipPath.clear(); outError.clear();
        if (startSec < 0 || (endSec > 0 && endSec <= startSec)) { outError = "Escolha um intervalo válido para o corte."; return false; }
        std::error_code ec;
        if (!fs::exists(sourcePath, ec)) { outError = "O clipe original não foi encontrado."; return false; }
        HRESULT coHr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        const bool shouldUninitialize = SUCCEEDED(coHr);
        HRESULT hr = MFStartup(MF_VERSION);
        if (FAILED(hr)) { if (shouldUninitialize) CoUninitialize(); outError = "Não foi possível iniciar o mecanismo de mídia do Windows."; return false; }
        IMFSourceReader* reader = nullptr; IMFSinkWriter* writer = nullptr; bool writing = false; bool ok = false;
        do {
            hr = MFCreateSourceReaderFromURL(sourcePath.c_str(), nullptr, &reader);
            if (FAILED(hr) || !reader) { outError = "Não foi possível abrir este MP4 para corte."; break; }
            struct StreamMap { DWORD input; DWORD output; bool isVideo; IMFMediaType* type; };
            std::vector<StreamMap> streams;
            for (DWORD input = 0; input < 8; ++input) {
                IMFMediaType* nativeType = nullptr; hr = reader->GetNativeMediaType(input, 0, &nativeType);
                if (hr == MF_E_INVALIDSTREAMNUMBER) break;
                if (FAILED(hr) || !nativeType) continue;
                GUID major = GUID_NULL; nativeType->GetGUID(MF_MT_MAJOR_TYPE, &major);
                if (major == MFMediaType_Video) streams.push_back({ input, 0, true, nativeType });
                else if (major == MFMediaType_Audio) streams.push_back({ input, 0, false, nativeType });
                else nativeType->Release();
            }
            if (streams.empty()) { outError = "O clipe não possui vídeo ou áudio compatível."; break; }
            fs::path src(sourcePath);
            const long long startMs = static_cast<long long>(startSec * 1000.0 + 0.5);
            const long long endMs = static_cast<long long>(endSec * 1000.0 + 0.5);
            int rotNorm = ((rotationDegrees % 360) + 360) % 360;
            std::wstring suffix;
            if (endSec > 0) {
                suffix += L"_corte_" + std::to_wstring(startMs) + L"ms-" + std::to_wstring(endMs) + L"ms";
            }
            if (rotNorm != 0) {
                suffix += L"_girado" + std::to_wstring(rotNorm) + L"graus";
            } else if (endSec <= 0) {
                suffix += L"_editado";
            }
            fs::path dst = src.parent_path() / (src.stem().wstring() + suffix + L".mp4");
            if (fs::exists(dst, ec)) dst = src.parent_path() / (src.stem().wstring() + suffix + L"_" + std::to_wstring(GetTickCount64()) + L".mp4");
            outClipPath = dst.wstring();
            hr = MFCreateSinkWriterFromURL(outClipPath.c_str(), nullptr, nullptr, &writer);
            if (FAILED(hr) || !writer) { outError = "Não foi possível criar o arquivo cortado."; break; }
            for (auto& stream : streams) {
                if (stream.isVideo && rotNorm != 0) {
                    UINT32 existingRot = 0;
                    stream.type->GetUINT32(MF_MT_VIDEO_ROTATION, &existingRot);
                    UINT32 addCCW = static_cast<UINT32>((360 - rotNorm) % 360);
                    UINT32 finalRot = (existingRot + addCCW) % 360;
                    stream.type->SetUINT32(MF_MT_VIDEO_ROTATION, finalRot);
                }
                hr = writer->AddStream(stream.type, &stream.output);
                if (SUCCEEDED(hr)) hr = writer->SetInputMediaType(stream.output, stream.type, nullptr);
                if (FAILED(hr)) { outError = "Formato de clipe não é compatível com corte rápido."; break; }
            }
            for (auto& stream : streams) if (stream.type) { stream.type->Release(); stream.type = nullptr; }
            if (FAILED(hr)) break;
            hr = writer->BeginWriting(); if (FAILED(hr)) { outError = "Não foi possível iniciar o corte."; break; } writing = true;
            if (startSec > 0.001) {
                PROPVARIANT pos; PropVariantInit(&pos); pos.vt = VT_I8; pos.hVal.QuadPart = static_cast<LONGLONG>(startSec * 10000000.0);
                hr = reader->SetCurrentPosition(GUID_NULL, pos); PropVariantClear(&pos);
                if (FAILED(hr)) { outError = "Este arquivo não permite posicionamento para corte."; break; }
            }
            const LONGLONG startHns = static_cast<LONGLONG>(startSec * 10000000.0);
            const LONGLONG endHns = endSec > 0 ? static_cast<LONGLONG>(endSec * 10000000.0) : 0;
            std::vector<bool> ended(streams.size(), false); size_t endedCount = 0;
            while (endedCount < streams.size()) {
                DWORD input = 0, flags = 0; LONGLONG time = 0; IMFSample* sample = nullptr;
                hr = reader->ReadSample(MF_SOURCE_READER_ANY_STREAM, 0, &input, &flags, &time, &sample);
                if (FAILED(hr)) { if (sample) sample->Release(); outError = "Falha ao ler o clipe."; break; }
                if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { if (sample) sample->Release(); break; }
                size_t index = streams.size(); for (size_t i = 0; i < streams.size(); ++i) if (streams[i].input == input) { index = i; break; }
                if (index == streams.size()) { if (sample) sample->Release(); continue; }
                if (endHns > 0 && time >= endHns) { if (!ended[index]) { ended[index] = true; ++endedCount; } if (sample) sample->Release(); continue; }
                if (sample) {
                    sample->SetSampleTime(time > startHns ? time - startHns : 0);
                    hr = writer->WriteSample(streams[index].output, sample);
                    sample->Release();
                    if (FAILED(hr)) { outError = "Falha ao gravar o corte."; break; }
                }
            }
            if (FAILED(hr)) break;
            hr = writer->Finalize(); writing = false; if (FAILED(hr)) { outError = "Não foi possível finalizar o corte."; break; }
            ok = true;
        } while (false);
        if (writer) { if (writing) writer->Finalize(); writer->Release(); }
        if (reader) reader->Release();
        MFShutdown(); if (shouldUninitialize) CoUninitialize();
        if (!ok) { if (!outClipPath.empty()) fs::remove(outClipPath, ec); outClipPath.clear(); }
        return ok;
    }

    // Renomeia um clipe. Mantém a extensão original.
    bool RenameClip(const std::wstring& filePath, const std::wstring& newBaseName, std::wstring& outNewPath, std::string& outError) {
        outNewPath.clear(); outError.clear();
        std::error_code ec;
        if (!fs::exists(filePath, ec)) { outError = "Arquivo original não encontrado."; return false; }
        if (newBaseName.empty()) { outError = "Nome inválido."; return false; }
        // sanitize: remove chars not allowed in filenames
        std::wstring safe;
        for (wchar_t c : newBaseName) {
            if (c == L'\\' || c == L'/' || c == L':' || c == L'*' || c == L'?' || c == L'"' || c == L'<' || c == L'>' || c == L'|') safe += L'_';
            else safe += c;
        }
        fs::path src(filePath);
        fs::path dst = src.parent_path() / (safe + src.extension().wstring());
        if (fs::exists(dst, ec) && dst != src) {
            dst = src.parent_path() / (safe + L"_" + std::to_wstring(GetTickCount64()) + src.extension().wstring());
        }
        fs::rename(src, dst, ec);
        if (ec) { outError = "Não foi possível renomear o arquivo: " + ec.message(); return false; }
        outNewPath = dst.wstring();
        return true;
    }

    // Gira um clipe em múltiplos de 90° de forma instantânea sem reencodar via metadados de orientação do container MP4.
    bool RotateClip(const std::wstring& sourcePath, int degrees, std::wstring& outClipPath, std::string& outError) {
        outClipPath.clear(); outError.clear();
        degrees = ((degrees % 360) + 360) % 360;
        if (degrees == 0) { outError = "Rotação de 0° não tem efeito."; return false; }
        std::error_code ec;
        if (!fs::exists(sourcePath, ec)) { outError = "Arquivo original não encontrado."; return false; }
        return TrimClip(sourcePath, 0.0, 0.0, degrees, outClipPath, outError);
    }

private:
    mutable std::mutex stateMutex;
    std::mutex opMutex;
    std::mutex clipMutex;
    RecorderSettings settings;

    std::atomic<bool> isRecording{false};
    std::atomic<bool> stopRequested{false};
    std::chrono::steady_clock::time_point recordingStartTime;
    std::wstring currentFile;
    std::thread workerThread;

    std::atomic<bool> isReplayBufferActive{false};
    std::atomic<bool> bufferStopRequested{false};
    std::thread bufferThread;
    fs::path bufferFolder;
    std::mutex bufferSegmentsMutex;
    std::vector<std::wstring> bufferSegments;
    std::wstring activeBufferSegment;

    void AddBufferSegment(const std::wstring& path) {
        std::lock_guard<std::mutex> lock(bufferSegmentsMutex);
        bufferSegments.push_back(path);
        while (bufferSegments.size() > 2) {
            std::error_code ec;
            fs::remove(bufferSegments.front(), ec);
            bufferSegments.erase(bufferSegments.begin());
        }
    }

    std::wstring GetLatestBufferSegment() {
        std::lock_guard<std::mutex> lock(bufferSegmentsMutex);
        if (bufferSegments.empty()) return L"";
        return bufferSegments.back();
    }


    std::wstring GetActiveBufferSegment() {
        std::lock_guard<std::mutex> lock(bufferSegmentsMutex);
        return activeBufferSegment;
    }

    void ReplayBufferWorker() {
        int segmentIndex = 0;
        while (!bufferStopRequested.load()) {
            std::wstringstream wss;
            wss << L"buffer_segment_" << (segmentIndex % 5) << L".mp4";
            std::wstring segFile = (bufferFolder / wss.str()).wstring();
            RecorderSettings replaySettings;
            {
                std::lock_guard<std::mutex> stateLock(stateMutex);
                replaySettings = settings;
            }
            const int segmentDuration = std::clamp(replaySettings.replayBufferSeconds, 15, 300);
            {
                std::lock_guard<std::mutex> segmentsLock(bufferSegmentsMutex);
                activeBufferSegment = segFile;
            }
            RecordingWorker(segFile, segmentDuration, true, replaySettings);

            if (bufferStopRequested.load()) break;

            AddBufferSegment(segFile);
            segmentIndex++;
        }
    }

    void RecordingWorker(const std::wstring& outputFile, int maxDurationSec, bool lowPowerReplay, const RecorderSettings& captureSettings) {
        HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION);

        // 0. Determinar Geometria de Captura e Orientacao
        int srcX = 0;
        int srcY = 0;
        int srcW = 0;
        int srcH = 0;
        bool autoFlipped = false;
        bool captureWindowMode = (captureSettings.captureTarget == "window" && captureSettings.targetHwnd && IsWindow(captureSettings.targetHwnd));

        if (captureWindowMode) {
            RECT rcWin = {0};
            GetWindowRect(captureSettings.targetHwnd, &rcWin);
            srcX = rcWin.left;
            srcY = rcWin.top;
            srcW = rcWin.right - rcWin.left;
            srcH = rcWin.bottom - rcWin.top;
            if (srcW <= 0 || srcH <= 0) {
                srcW = 1920; srcH = 1080;
            }
            HMONITOR hMon = MonitorFromWindow(captureSettings.targetHwnd, MONITOR_DEFAULTTONEAREST);
            if (hMon) {
                MONITORINFOEXW mi;
                mi.cbSize = sizeof(mi);
                if (GetMonitorInfoW(hMon, &mi)) {
                    DEVMODEW dm = {0};
                    dm.dmSize = sizeof(dm);
                    if (EnumDisplaySettingsW(mi.szDevice, ENUM_CURRENT_SETTINGS, &dm)) {
                        if (dm.dmDisplayOrientation == DMDO_180) {
                            autoFlipped = true;
                        }
                    }
                }
            }
        } else {
            auto monitors = GetSystemMonitors();
            int mIdx = captureSettings.monitorIndex;
            if (mIdx >= 0 && mIdx < (int)monitors.size()) {
                srcX = monitors[mIdx].x;
                srcY = monitors[mIdx].y;
                srcW = monitors[mIdx].width;
                srcH = monitors[mIdx].height;
                if (monitors[mIdx].orientation == 2) {
                    autoFlipped = true;
                }
            } else if (!monitors.empty()) {
                srcX = monitors[0].x;
                srcY = monitors[0].y;
                srcW = monitors[0].width;
                srcH = monitors[0].height;
                if (monitors[0].orientation == 2) {
                    autoFlipped = true;
                }
            } else {
                srcX = 0;
                srcY = 0;
                srcW = GetSystemMetrics(SM_CXSCREEN);
                srcH = GetSystemMetrics(SM_CYSCREEN);
            }
        }

        // Orientacao correta: auto-deteccao de tela 180 ou toggle manual ativado
        bool isFlipped180 = autoFlipped || captureSettings.flip180;

        // Resolucao de Saida (High Quality & Multiplos de 2)
        int width = captureSettings.targetWidth;
        int height = captureSettings.targetHeight;
        int fps = captureSettings.fps > 0 ? captureSettings.fps : 60;
        int bitrate = captureSettings.bitrate;

        if (captureSettings.resolutionMode == "custom") {
            // Modo Personalizado: respeitar estritamente resolução, FPS e bitrate configurados pelo usuário
            if (width <= 0) width = 1920;
            if (height <= 0) height = 1080;
            // Limitar a no máximo 4K (3840x2160) conforme especificado pelo usuário
            if (width > 3840) width = 3840;
            if (height > 2160) height = 2160;
            width = (width / 2) * 2;
            height = (height / 2) * 2;
            if (width < 320) width = 320;
            if (height < 240) height = 240;

            // Limitar a no máximo 120 FPS
            if (fps > 120) fps = 120;
            if (fps < 15) fps = 15;

            // Bitrate customizado: mínimo 2 Mbps, máximo 150 Mbps (balanceado para até 120 FPS)
            if (bitrate <= 0) bitrate = 25000000;
            if (bitrate > 150000000) bitrate = 150000000;
            if (bitrate < 2000000) bitrate = 2000000;
        } else {
            if (captureSettings.resolutionMode == "native" || width <= 0 || height <= 0) {
                width = srcW;
                height = srcH;
            }

            width = (width / 2) * 2;
            height = (height / 2) * 2;
            if (width < 320) width = 1280;
            if (height < 240) height = 720;

            // Nunca aumente artificialmente a resolução da origem nos modos pré-definidos
            if (srcW > 0 && srcH > 0 && (width > srcW || height > srcH)) {
                const double scale = (std::min)(1.0, (std::min)(static_cast<double>(width) / srcW, static_cast<double>(height) / srcH));
                width = (std::max)(320, (static_cast<int>(srcW * scale) / 2) * 2);
                height = (std::max)(240, (static_cast<int>(srcH * scale) / 2) * 2);
            }

            // Bitrate Gamer Real (Aumento Efetivo de Qualidade)
            if (captureSettings.resolutionMode == "native") {
                if (width >= 2560 || height >= 1440) bitrate = 50000000;
                else if (width >= 1920 || height >= 1080) bitrate = 25000000;
                else bitrate = 12000000;
            } else if (captureSettings.resolutionMode == "1440p60" || (width >= 2560 && height >= 1440)) {
                bitrate = 35000000;
            } else if (captureSettings.resolutionMode == "1080p60" || (width >= 1920 && height >= 1080)) {
                bitrate = 20000000;
            } else if (captureSettings.resolutionMode == "720p60" || (width <= 1280 && height <= 720)) {
                bitrate = 8000000;
            } else if (bitrate < 8000000) {
                bitrate = 20000000;
            }
        }

        // O replay é contínuo. Ele usa um perfil separado para não disputar recursos
        // com o jogo; a gravação manual preserva a qualidade escolhida pelo usuário.
        if (lowPowerReplay) {
            if (captureSettings.replayQuality == "economy") {
                width = 1280; height = 720; fps = 30; bitrate = 5000000;
            } else if (captureSettings.replayQuality == "high") {
                width = 1920; height = 1080; fps = 60; bitrate = 14000000;
            } else {
                width = 1280; height = 720; fps = 60; bitrate = 8000000;
            }
            if (srcW > 0 && srcH > 0 && (width > srcW || height > srcH)) {
                const double replayScale = (std::min)(1.0, (std::min)(static_cast<double>(width) / srcW, static_cast<double>(height) / srcH));
                width = (std::max)(320, (static_cast<int>(srcW * replayScale) / 2) * 2);
                height = (std::max)(240, (static_cast<int>(srcH * replayScale) / 2) * 2);
            }
        } else if (captureSettings.resolutionMode != "custom") {
            if (width <= 1280 && height <= 720) {
                bitrate = (std::min)(bitrate, 8000000);
            } else if (width <= 1600 && height <= 900) {
                bitrate = (std::min)(bitrate, 12000000);
            }
        }

        IMFAttributes* pAttr = NULL;
        MFCreateAttributes(&pAttr, 2);
        if (pAttr) {
            pAttr->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
            pAttr->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, lowPowerReplay ? FALSE : TRUE);
        }

        IMFSinkWriter* pWriter = NULL;
        hr = MFCreateSinkWriterFromURL(outputFile.c_str(), NULL, pAttr, &pWriter);
        if (pAttr) pAttr->Release();

        if (FAILED(hr) || !pWriter) {
            MFShutdown();
            CoUninitialize();
            return;
        }

        // 1. Configurar Fluxo de Video de Saida (H.264 MP4 High Profile)
        IMFMediaType* pVideoOut = NULL;
        MFCreateMediaType(&pVideoOut);
        pVideoOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        pVideoOut->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
        pVideoOut->SetUINT32(MF_MT_AVG_BITRATE, bitrate);
        pVideoOut->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        pVideoOut->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
        MFSetAttributeSize(pVideoOut, MF_MT_FRAME_SIZE, width, height);
        MFSetAttributeRatio(pVideoOut, MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(pVideoOut, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

        DWORD vStream = 0;
        pWriter->AddStream(pVideoOut, &vStream);
        pVideoOut->Release();

        // 2. Configurar Fluxo de Video de Entrada (RGB32)
        IMFMediaType* pVideoIn = NULL;
        MFCreateMediaType(&pVideoIn);
        pVideoIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
        pVideoIn->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
        pVideoIn->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
        MFSetAttributeSize(pVideoIn, MF_MT_FRAME_SIZE, width, height);
        MFSetAttributeRatio(pVideoIn, MF_MT_FRAME_RATE, fps, 1);
        MFSetAttributeRatio(pVideoIn, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
        pVideoIn->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(-width * 4));

        pWriter->SetInputMediaType(vStream, pVideoIn, NULL);
        pVideoIn->Release();

        // 3. Configurar Fluxo de Audio de Saida (AAC 192kbps)
        IMFMediaType* pAudioOut = NULL;
        MFCreateMediaType(&pAudioOut);
        pAudioOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        pAudioOut->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
        pAudioOut->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
        pAudioOut->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
        pAudioOut->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        pAudioOut->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24000); // 192 kbps

        DWORD aStream = 0;
        pWriter->AddStream(pAudioOut, &aStream);
        pAudioOut->Release();

        // 4. Configurar Fluxo de Audio de Entrada (PCM 16-bit 48kHz Stereo)
        IMFMediaType* pAudioIn = NULL;
        MFCreateMediaType(&pAudioIn);
        pAudioIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        pAudioIn->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
        pAudioIn->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
        pAudioIn->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
        pAudioIn->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
        pAudioIn->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
        pAudioIn->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 48000 * 4);

        pWriter->SetInputMediaType(aStream, pAudioIn, NULL);
        pAudioIn->Release();

        hr = pWriter->BeginWriting();
        if (FAILED(hr)) {
            pWriter->Release();
            MFShutdown();
            CoUninitialize();
            return;
        }

        // DC de Captura (Desktop Virtual Cobrindo Todos os Monitores)
        HDC hdcScreen = GetDC(NULL);
        HDC hdcMem = CreateCompatibleDC(hdcScreen);

        BITMAPINFO bmi = {0};
        bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bmi.bmiHeader.biWidth = width;
        bmi.bmiHeader.biHeight = height; // Bottom-up DIB: matches the Media Foundation RGB32 layout
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;

        void* pBits = nullptr;
        HBITMAP hbm = CreateDIBSection(hdcMem, &bmi, DIB_RGB_COLORS, &pBits, NULL, 0);
        HBITMAP oldBmp = (HBITMAP)SelectObject(hdcMem, hbm);

        // Para monitores, use Desktop Duplication (D3D11). Janelas específicas
        // mantêm o fallback GDI porque precisam recortar uma área variável.
        DesktopDuplicationCapture gpuCapture;
        bool gpuCaptureReady = !captureWindowMode && gpuCapture.Initialize(captureSettings.monitorIndex);

        // COLORONCOLOR é muito mais leve para vídeo em tempo real que HALFTONE.
        // Quando não há redimensionamento, BitBlt evita o scaler por completo.
        SetStretchBltMode(hdcMem, COLORONCOLOR);
        SetBrushOrgEx(hdcMem, 0, 0, NULL);

        // WASAPI Audio
        IMMDeviceEnumerator* pEnumerator = NULL;
        IMMDevice* pAudioDevice = NULL;
        IAudioClient* pAudioClient = NULL;
        IAudioCaptureClient* pCaptureClient = NULL;
        IMMDevice* pMicDevice = NULL;
        IAudioClient* pMicAudioClient = NULL;
        IAudioCaptureClient* pMicCaptureClient = NULL;
        bool hasAudio = false;
        bool hasMic = false;

        if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator))) {
            if (SUCCEEDED(pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pAudioDevice))) {
                if (SUCCEEDED(pAudioDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pAudioClient))) {
                    WAVEFORMATEX wfxAudio = {0};
                    wfxAudio.wFormatTag = WAVE_FORMAT_PCM;
                    wfxAudio.nChannels = 2;
                    wfxAudio.nSamplesPerSec = 48000;
                    wfxAudio.wBitsPerSample = 16;
                    wfxAudio.nBlockAlign = 4;
                    wfxAudio.nAvgBytesPerSec = 48000 * 4;

                    REFERENCE_TIME hnsBufferDuration = 10000000; // 1s
                    hr = pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, hnsBufferDuration, 0, &wfxAudio, NULL);
                    if (SUCCEEDED(hr)) {
                        if (SUCCEEDED(pAudioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCaptureClient))) {
                            pAudioClient->Start();
                            hasAudio = true;
                        }
                    }
                }
            }
        }

        HRESULT micDeviceHr = E_FAIL;
        if (captureSettings.recordMic && pEnumerator) {
            if (!captureSettings.micDeviceId.empty()) {
                micDeviceHr = pEnumerator->GetDevice(captureSettings.micDeviceId.c_str(), &pMicDevice);
            } else {
                micDeviceHr = pEnumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &pMicDevice);
            }
        }
        if (captureSettings.recordMic && SUCCEEDED(micDeviceHr) && pMicDevice &&
            SUCCEEDED(pMicDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pMicAudioClient))) {
            WAVEFORMATEX micFormat = {};
            micFormat.wFormatTag = WAVE_FORMAT_PCM;
            micFormat.nChannels = 2;
            micFormat.nSamplesPerSec = 48000;
            micFormat.wBitsPerSample = 16;
            micFormat.nBlockAlign = 4;
            micFormat.nAvgBytesPerSec = 48000 * 4;
            const DWORD micFlags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            if (SUCCEEDED(pMicAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, micFlags, 10000000, 0, &micFormat, NULL)) &&
                SUCCEEDED(pMicAudioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pMicCaptureClient)) &&
                SUCCEEDED(pMicAudioClient->Start())) hasMic = true;
        }
        const LONGLONG frameDuration = 10000000LL / fps; // 100ns units
        LONGLONG videoTimestamp = 0;
        LONGLONG audioTimestamp = 0;

        auto startTime = std::chrono::steady_clock::now();
        auto nextFrameTime = startTime;
        auto frameInterval = std::chrono::nanoseconds(1000000000LL / fps);
        std::vector<BYTE> micSamples;

        // Cada modo deve obedecer apenas ao seu proprio sinal. Antes, parar o
        // replay tambem encerrava a gravacao normal (e vice-versa), criando MP4
        // de 0 bytes e podendo reiniciar segmentos vazios em sequencia.
        while (lowPowerReplay ? !bufferStopRequested.load() : !stopRequested.load()) {
            auto now = std::chrono::steady_clock::now();

            if (maxDurationSec > 0) {
                int elapsed = (int)std::chrono::duration_cast<std::chrono::seconds>(now - startTime).count();
                if (elapsed >= maxDurationSec) break;
            }

            if (captureWindowMode && captureSettings.targetHwnd && IsWindow(captureSettings.targetHwnd)) {
                RECT rcCur = {0};
                if (GetWindowRect(captureSettings.targetHwnd, &rcCur)) {
                    int curW = rcCur.right - rcCur.left;
                    int curH = rcCur.bottom - rcCur.top;
                    if (curW > 0 && curH > 0) {
                        srcX = rcCur.left;
                        srcY = rcCur.top;
                        srcW = curW;
                        srcH = curH;
                    }
                }
            }

            // Desktop Duplication evita BitBlt a cada quadro. Se a API não estiver
            // disponível ou a sessão for uma janela recortada, mantenha o fallback seguro.
            const bool capturedByGpu = gpuCaptureReady && gpuCapture.CopyFrame(static_cast<BYTE*>(pBits), width, height);
            if (!capturedByGpu) {
                if (srcW == width && srcH == height) BitBlt(hdcMem, 0, 0, width, height, hdcScreen, srcX, srcY, SRCCOPY);
                else StretchBlt(hdcMem, 0, 0, width, height, hdcScreen, srcX, srcY, srcW, srcH, SRCCOPY);
            }

            // O desktop capturado pelo GDI não inclui necessariamente o cursor.
            // Componha-o na própria superfície antes de enviá-la ao codificador;
            // assim a opção também funciona em clipes sem uma etapa extra de vídeo.
            if (captureSettings.cursorMode != "hidden" && srcW > 0 && srcH > 0) {
                CURSORINFO cursorInfo = { sizeof(cursorInfo) };
                if (GetCursorInfo(&cursorInfo) && (cursorInfo.flags & CURSOR_SHOWING)) {
                    const POINT mouse = cursorInfo.ptScreenPos;
                    if (mouse.x >= srcX && mouse.x < srcX + srcW && mouse.y >= srcY && mouse.y < srcY + srcH) {
                        const float scaleX = static_cast<float>(width) / static_cast<float>(srcW);
                        const float scaleY = static_cast<float>(height) / static_cast<float>(srcH);
                        const int cursorX = static_cast<int>((mouse.x - srcX) * scaleX);
                        const int cursorY = static_cast<int>((mouse.y - srcY) * scaleY);
                        const float iconScale = (std::max)(0.55f, (std::min)(1.75f, (scaleX + scaleY) * 0.5f));

                        if (captureSettings.cursorMode == "highlight") {
                            const int radius = (std::max)(18, static_cast<int>(28.0f * iconScale));
                            HPEN outerPen = CreatePen(PS_SOLID, 5, RGB(15, 23, 42));
                            HGDIOBJ oldPen = SelectObject(hdcMem, outerPen);
                            HGDIOBJ oldBrush = SelectObject(hdcMem, GetStockObject(HOLLOW_BRUSH));
                            Ellipse(hdcMem, cursorX - radius, cursorY - radius, cursorX + radius, cursorY + radius);
                            SelectObject(hdcMem, oldPen);
                            DeleteObject(outerPen);

                            HPEN highlightPen = CreatePen(PS_SOLID, 2, RGB(56, 189, 248));
                            oldPen = SelectObject(hdcMem, highlightPen);
                            Ellipse(hdcMem, cursorX - radius, cursorY - radius, cursorX + radius, cursorY + radius);
                            SelectObject(hdcMem, oldPen);
                            SelectObject(hdcMem, oldBrush);
                            DeleteObject(highlightPen);
                        }

                        ICONINFO iconInfo = {};
                        if (GetIconInfo(cursorInfo.hCursor, &iconInfo)) {
                            const int iconWidth = (std::max)(16, static_cast<int>(GetSystemMetrics(SM_CXCURSOR) * iconScale));
                            const int iconHeight = (std::max)(16, static_cast<int>(GetSystemMetrics(SM_CYCURSOR) * iconScale));
                            DrawIconEx(hdcMem,
                                       cursorX - static_cast<int>(iconInfo.xHotspot * iconScale),
                                       cursorY - static_cast<int>(iconInfo.yHotspot * iconScale),
                                       cursorInfo.hCursor, iconWidth, iconHeight, 0, NULL, DI_NORMAL);
                            if (iconInfo.hbmMask) DeleteObject(iconInfo.hbmMask);
                            if (iconInfo.hbmColor) DeleteObject(iconInfo.hbmColor);
                        }
                    }
                }
            }

            // Timestamp de video amarrado estritamente ao tempo real (Wall Clock)
            LONGLONG currentVideoTime = std::chrono::duration_cast<std::chrono::nanoseconds>(now - startTime).count() / 100;
            if (currentVideoTime < videoTimestamp) currentVideoTime = videoTimestamp;

            IMFMediaBuffer* pBuffer = NULL;
            if (SUCCEEDED(MFCreateMemoryBuffer(width * height * 4, &pBuffer))) {
                BYTE* pData = NULL;
                pBuffer->Lock(&pData, NULL, NULL);
                memcpy(pData, pBits, width * height * 4);
                pBuffer->Unlock();
                pBuffer->SetCurrentLength(width * height * 4);

                IMFSample* pSample = NULL;
                if (SUCCEEDED(MFCreateSample(&pSample))) {
                    pSample->AddBuffer(pBuffer);
                    pSample->SetSampleTime(currentVideoTime);
                    pSample->SetSampleDuration(frameDuration);

                    pWriter->WriteSample(vStream, pSample);
                    pSample->Release();
                }
                pBuffer->Release();
            }

            videoTimestamp = currentVideoTime + frameDuration;

            // Capturar Audio WASAPI com sincronizacao de tempo real
            if (hasAudio && pCaptureClient) {
                micSamples.clear();
                if (hasMic && pMicCaptureClient) {
                    UINT32 micPacketLength = 0;
                    while (SUCCEEDED(pMicCaptureClient->GetNextPacketSize(&micPacketLength)) && micPacketLength > 0) {
                        BYTE* micData = NULL; UINT32 micFrames = 0; DWORD micFlags = 0;
                        if (SUCCEEDED(pMicCaptureClient->GetBuffer(&micData, &micFrames, &micFlags, NULL, NULL))) {
                            const DWORD micBytes = micFrames * 4;
                            micSamples.resize(micBytes);
                            if ((micFlags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && micData) memcpy(micSamples.data(), micData, micBytes);
                            else if (micBytes) memset(micSamples.data(), 0, micBytes);
                            pMicCaptureClient->ReleaseBuffer(micFrames);
                        }
                    }
                }
                UINT32 packetLength = 0;
                while (SUCCEEDED(pCaptureClient->GetNextPacketSize(&packetLength)) && packetLength > 0) {
                    BYTE* pAudioData = NULL;
                    UINT32 numFramesRead = 0;
                    DWORD flags = 0;
                    if (SUCCEEDED(pCaptureClient->GetBuffer(&pAudioData, &numFramesRead, &flags, NULL, NULL))) {
                        if (numFramesRead > 0) {
                            DWORD byteCount = numFramesRead * 4;
                            IMFMediaBuffer* pABuffer = NULL;
                            if (SUCCEEDED(MFCreateMemoryBuffer(byteCount, &pABuffer))) {
                                BYTE* pDest = NULL;
                                pABuffer->Lock(&pDest, NULL, NULL);
                                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                                    memset(pDest, 0, byteCount);
                                } else {
                                    memcpy(pDest, pAudioData, byteCount);
                                    const size_t samples = (std::min)(static_cast<size_t>(byteCount), micSamples.size()) / sizeof(int16_t);
                                    auto* mixed = reinterpret_cast<int16_t*>(pDest);
                                    const auto* mic = reinterpret_cast<const int16_t*>(micSamples.data());
                                    for (size_t i = 0; i < samples; ++i) {
                                        const int value = static_cast<int>(mixed[i]) + static_cast<int>(mic[i]);
                                        mixed[i] = static_cast<int16_t>((std::max)(-32768, (std::min)(32767, value)));
                                    }
                                }
                                pABuffer->Unlock();
                                pABuffer->SetCurrentLength(byteCount);

                                IMFSample* pASample = NULL;
                                if (SUCCEEDED(MFCreateSample(&pASample))) {
                                    pASample->AddBuffer(pABuffer);
                                    LONGLONG sampleDur = (LONGLONG)numFramesRead * 10000000LL / 48000LL;
                                    pASample->SetSampleTime(audioTimestamp);
                                    pASample->SetSampleDuration(sampleDur);

                                    pWriter->WriteSample(aStream, pASample);
                                    audioTimestamp += sampleDur;
                                    pASample->Release();
                                }
                                pABuffer->Release();
                            }
                        }
                        pCaptureClient->ReleaseBuffer(numFramesRead);
                    }
                }
            }

            // Se WASAPI estiver silencioso ou sem pacotes, preencher silencio alinhado ao video
            if (audioTimestamp < videoTimestamp) {
                LONGLONG diffTime = videoTimestamp - audioTimestamp;
                UINT32 silenceFrames = (UINT32)(diffTime * 48000LL / 10000000LL);
                if (silenceFrames > 0) {
                    if (silenceFrames > 4800) silenceFrames = 4800; // max 100ms por iteracao
                    DWORD byteCount = silenceFrames * 4;
                    IMFMediaBuffer* pABuffer = NULL;
                    if (SUCCEEDED(MFCreateMemoryBuffer(byteCount, &pABuffer))) {
                        BYTE* pDest = NULL;
                        pABuffer->Lock(&pDest, NULL, NULL);
                        memset(pDest, 0, byteCount);
                        pABuffer->Unlock();
                        pABuffer->SetCurrentLength(byteCount);

                        IMFSample* pASample = NULL;
                        if (SUCCEEDED(MFCreateSample(&pASample))) {
                            pASample->AddBuffer(pABuffer);
                            LONGLONG sampleDur = (LONGLONG)silenceFrames * 10000000LL / 48000LL;
                            pASample->SetSampleTime(audioTimestamp);
                            pASample->SetSampleDuration(sampleDur);

                            pWriter->WriteSample(aStream, pASample);
                            audioTimestamp += sampleDur;
                            pASample->Release();
                        }
                        pABuffer->Release();
                    }
                }
            }

            nextFrameTime += frameInterval;
            const auto frameFinishedAt = std::chrono::steady_clock::now();
            if (frameFinishedAt < nextFrameTime) {
                std::this_thread::sleep_until(nextFrameTime);
            } else {
                // Não acumule dívida de quadros. Quando a captura/codificação fica
                // lenta, descarte o atraso em vez de gerar rajadas que travam o PC.
                nextFrameTime = frameFinishedAt;
            }
        }

        pWriter->Finalize();
        pWriter->Release();

        if (pAudioClient) {
            pAudioClient->Stop();
            pAudioClient->Release();
        }
        if (pCaptureClient) pCaptureClient->Release();
        if (pMicAudioClient) { pMicAudioClient->Stop(); pMicAudioClient->Release(); }
        if (pMicCaptureClient) pMicCaptureClient->Release();
        if (pMicDevice) pMicDevice->Release();
        if (pAudioDevice) pAudioDevice->Release();
        if (pEnumerator) pEnumerator->Release();

        gpuCapture.Shutdown();
        SelectObject(hdcMem, oldBmp);
        DeleteObject(hbm);
        DeleteDC(hdcMem);
        ReleaseDC(NULL, hdcScreen);

        MFShutdown();
        CoUninitialize();
    }
};

} // namespace DiscordUnlock

