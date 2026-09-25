#pragma once

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <propsys.h>
#include <functiondiscoverykeys_devpkey.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cwctype>
#include <climits>
#include <cmath>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

namespace DiscordUnlock {

class NativeSoundboardEngine {
public:
    using Completion = std::function<void(bool, const std::string&)>;

    static NativeSoundboardEngine& Instance() {
        static NativeSoundboardEngine engine;
        return engine;
    }

    bool Play(const std::string& soundId,
              const std::wstring& filePath,
              const std::wstring& endpointLabel,
              float gain,
              Completion completion) {
        std::error_code ec;
        if (soundId.empty() || !std::filesystem::exists(filePath, ec) ||
            !std::filesystem::is_regular_file(filePath, ec)) {
            if (completion) completion(false, "Arquivo de audio nao encontrado.");
            return false;
        }

        auto cancel = std::make_shared<std::atomic<bool>>(false);
        {
            std::lock_guard<std::mutex> lock(mutex_);
            // O soundpad trabalha com uma reprodução por vez: iniciar outro som
            // encerra todo áudio anterior, inclusive o disparado por atalho global.
            for (auto& entry : active_) entry.second->store(true);
            active_.clear();
            active_[soundId] = cancel;
        }

        const float safeGain = (std::max)(0.0f, (std::min)(2.0f, gain));
        liveGain_.store(safeGain);
        std::thread([this, soundId, filePath, endpointLabel, safeGain, cancel, completion]() {
            RunPlayback(soundId, filePath, endpointLabel, safeGain, cancel, completion);
        }).detach();
        return true;
    }

    void Stop(const std::string& soundId) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = active_.find(soundId);
        if (it != active_.end()) it->second->store(true);
    }

    void StopAll() {
        std::lock_guard<std::mutex> lock(mutex_);
        for (auto& entry : active_) entry.second->store(true);
    }

    void SetGainForAll(float gain) {
        liveGain_.store((std::max)(0.0f, (std::min)(2.0f, gain)));
    }

private:
    std::atomic<float> liveGain_{1.0f};
    std::mutex mutex_;
    std::unordered_map<std::string, std::shared_ptr<std::atomic<bool>>> active_;

    static std::wstring Lower(std::wstring value) {
        std::transform(value.begin(), value.end(), value.begin(), [](wchar_t c) {
            return static_cast<wchar_t>(towlower(c));
        });
        return value;
    }

    static IMMDevice* FindRenderDevice(IMMDeviceEnumerator* enumerator, const std::wstring& label) {
        if (!enumerator) return nullptr;
        if (label.empty() || label == L"default") {
            IMMDevice* device = nullptr;
            if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device))) return device;
            return nullptr;
        }

        IMMDeviceCollection* collection = nullptr;
        if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &collection)) || !collection) return nullptr;
        IMMDevice* match = nullptr;
        const std::wstring requested = Lower(label);
        UINT count = 0;
        collection->GetCount(&count);
        for (UINT i = 0; i < count && !match; ++i) {
            IMMDevice* candidate = nullptr;
            if (FAILED(collection->Item(i, &candidate)) || !candidate) continue;
            IPropertyStore* properties = nullptr;
            PROPVARIANT value;
            PropVariantInit(&value);
            std::wstring name;
            if (SUCCEEDED(candidate->OpenPropertyStore(STGM_READ, &properties)) && properties &&
                SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &value)) &&
                value.vt == VT_LPWSTR && value.pwszVal) {
                name = value.pwszVal;
            }
            if (properties) properties->Release();
            PropVariantClear(&value);
            const std::wstring normalizedName = Lower(name);
            if (!normalizedName.empty() &&
                (requested.find(normalizedName) != std::wstring::npos || normalizedName.find(requested) != std::wstring::npos)) {
                match = candidate;
            } else {
                candidate->Release();
            }
        }
        collection->Release();
        return match;
    }

    static void ApplyGain(BYTE* bytes, size_t byteCount, const WAVEFORMATEX* format, float gain) {
        if (!bytes || !format || gain == 1.0f) return;
        bool isFloat = format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
        if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && format->cbSize >= 22) {
            const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
            isFloat = extensible->SubFormat == MFAudioFormat_Float;
        }
        if (isFloat && format->wBitsPerSample == 32) {
            float* samples = reinterpret_cast<float*>(bytes);
            const size_t count = byteCount / sizeof(float);
            for (size_t i = 0; i < count; ++i) samples[i] = (std::max)(-1.0f, (std::min)(1.0f, samples[i] * gain));
        } else if (format->wBitsPerSample == 16) {
            int16_t* samples = reinterpret_cast<int16_t*>(bytes);
            const size_t count = byteCount / sizeof(int16_t);
            for (size_t i = 0; i < count; ++i) {
                const int value = static_cast<int>(std::lround(samples[i] * gain));
                samples[i] = static_cast<int16_t>((std::max)(-32768, (std::min)(32767, value)));
            }
        } else if (format->wBitsPerSample == 32) {
            int32_t* samples = reinterpret_cast<int32_t*>(bytes);
            const size_t count = byteCount / sizeof(int32_t);
            for (size_t i = 0; i < count; ++i) {
                const double value = static_cast<double>(samples[i]) * gain;
                samples[i] = static_cast<int32_t>((std::max)(static_cast<double>(INT32_MIN), (std::min)(static_cast<double>(INT32_MAX), value)));
            }
        }
    }

    void Finish(const std::string& soundId,
                const std::shared_ptr<std::atomic<bool>>& cancel,
                bool success,
                const std::string& error,
                const Completion& completion) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            auto it = active_.find(soundId);
            if (it != active_.end() && it->second == cancel) active_.erase(it);
        }
        if (completion) completion(success, error);
    }

    void RunPlayback(const std::string& soundId,
                     const std::wstring& filePath,
                     const std::wstring& endpointLabel,
                     float gain,
                     const std::shared_ptr<std::atomic<bool>>& cancel,
                     const Completion& completion) {
        HRESULT coResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        const bool uninitialize = SUCCEEDED(coResult);
        const HRESULT mfResult = MFStartup(MF_VERSION);
        bool success = false;
        std::string error = "Falha ao iniciar o mecanismo de audio do Windows.";
        size_t bytesWritten = 0;

        IMMDeviceEnumerator* enumerator = nullptr;
        IMMDevice* device = nullptr;
        IAudioClient* audioClient = nullptr;
        IAudioRenderClient* renderClient = nullptr;
        WAVEFORMATEX* mixFormat = nullptr;
        IMFSourceReader* reader = nullptr;
        IMFAttributes* attributes = nullptr;
        IMFMediaType* decodedType = nullptr;
        bool audioStarted = false;

        do {
            if (FAILED(mfResult)) break;
            if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator))) || !enumerator) {
                error = "Nao foi possivel abrir os dispositivos de audio.";
                break;
            }
            device = FindRenderDevice(enumerator, endpointLabel);
            if (!device) {
                error = "O dispositivo CABLE Input selecionado nao foi encontrado.";
                break;
            }
            if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&audioClient))) || !audioClient ||
                FAILED(audioClient->GetMixFormat(&mixFormat)) || !mixFormat) {
                error = "O dispositivo de transmissao nao aceitou a conexao.";
                break;
            }
            if (FAILED(audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, mixFormat, nullptr))) {
                error = "Nao foi possivel iniciar o CABLE Input. Verifique se outro programa bloqueou o dispositivo.";
                break;
            }
            UINT32 bufferFrames = 0;
            if (FAILED(audioClient->GetBufferSize(&bufferFrames)) ||
                FAILED(audioClient->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&renderClient))) || !renderClient) {
                error = "Falha ao preparar a saida de audio.";
                break;
            }

            if (FAILED(MFCreateSourceReaderFromURL(filePath.c_str(), attributes, &reader)) || !reader) {
                error = "O MP3/WAV nao pode ser decodificado pelo Windows.";
                break;
            }
            reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
            reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE);

            if (FAILED(MFCreateMediaType(&decodedType)) || !decodedType) break;
            bool isFloat = mixFormat->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
            if (mixFormat->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mixFormat->cbSize >= 22) {
                const auto* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(mixFormat);
                isFloat = extensible->SubFormat == MFAudioFormat_Float;
            }
            decodedType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
            decodedType->SetGUID(MF_MT_SUBTYPE, isFloat ? MFAudioFormat_Float : MFAudioFormat_PCM);
            decodedType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, mixFormat->nChannels);
            decodedType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, mixFormat->nSamplesPerSec);
            decodedType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, mixFormat->wBitsPerSample);
            decodedType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, mixFormat->nBlockAlign);
            decodedType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, mixFormat->nAvgBytesPerSec);
            decodedType->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
            if (FAILED(reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, decodedType))) {
                error = "O formato de audio nao e compativel com o dispositivo selecionado.";
                break;
            }

            if (FAILED(audioClient->Start())) {
                error = "Nao foi possivel iniciar a reproducao no CABLE Input.";
                break;
            }
            audioStarted = true;
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);

            while (!cancel->load()) {
                DWORD streamIndex = 0, flags = 0;
                LONGLONG timestamp = 0;
                IMFSample* sample = nullptr;
                HRESULT readResult = reader->ReadSample(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0,
                                                        &streamIndex, &flags, &timestamp, &sample);
                if (FAILED(readResult)) {
                    error = "Falha ao ler o arquivo de audio.";
                    if (sample) sample->Release();
                    break;
                }
                if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
                    if (sample) sample->Release();
                    success = bytesWritten > 0;
                    if (success) error.clear();
                    else error = "O arquivo de audio nao possui amostras validas.";
                    break;
                }
                if (!sample) continue;

                IMFMediaBuffer* mediaBuffer = nullptr;
                if (SUCCEEDED(sample->ConvertToContiguousBuffer(&mediaBuffer)) && mediaBuffer) {
                    BYTE* source = nullptr;
                    DWORD currentLength = 0;
                    if (SUCCEEDED(mediaBuffer->Lock(&source, nullptr, &currentLength)) && source) {
                        ApplyGain(source, currentLength, mixFormat, liveGain_.load());
                        size_t offset = 0;
                        const UINT32 frameBytes = mixFormat->nBlockAlign;
                        while (!cancel->load() && offset + frameBytes <= currentLength) {
                            UINT32 padding = 0;
                            if (FAILED(audioClient->GetCurrentPadding(&padding))) break;
                            const UINT32 available = bufferFrames > padding ? bufferFrames - padding : 0;
                            if (!available) { Sleep(1); continue; }
                            const UINT32 remainingFrames = static_cast<UINT32>((currentLength - offset) / frameBytes);
                            const UINT32 frames = (std::min)(available, remainingFrames);
                            BYTE* destination = nullptr;
                            if (FAILED(renderClient->GetBuffer(frames, &destination)) || !destination) break;
                            const size_t bytes = static_cast<size_t>(frames) * frameBytes;
                            memcpy(destination, source + offset, bytes);
                            if (FAILED(renderClient->ReleaseBuffer(frames, 0))) break;
                            offset += bytes;
                            bytesWritten += bytes;
                        }
                        mediaBuffer->Unlock();
                    }
                    mediaBuffer->Release();
                }
                sample->Release();
            }

            if (cancel->load()) {
                success = true;
                error.clear();
            } else if (success) {
                for (int i = 0; i < 100; ++i) {
                    UINT32 padding = 0;
                    if (FAILED(audioClient->GetCurrentPadding(&padding)) || padding == 0) break;
                    Sleep(5);
                }
            }
        } while (false);

        if (audioStarted && audioClient) audioClient->Stop();
        if (decodedType) decodedType->Release();
        if (reader) reader->Release();
        if (attributes) attributes->Release();
        if (mixFormat) CoTaskMemFree(mixFormat);
        if (renderClient) renderClient->Release();
        if (audioClient) audioClient->Release();
        if (device) device->Release();
        if (enumerator) enumerator->Release();
        if (SUCCEEDED(mfResult)) MFShutdown();
        if (uninitialize) CoUninitialize();

        Finish(soundId, cancel, success, error, completion);
    }
};

} // namespace DiscordUnlock
