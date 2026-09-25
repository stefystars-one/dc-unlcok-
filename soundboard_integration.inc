fs::path materializeSoundboardFile(const std::string& soundId,
                                   const std::string& soundName,
                                   const std::string& fileName,
                                   const std::string& dataUrl,
                                   std::string& storedFileName,
                                   std::string& error) {
  const fs::path soundsDir = getLocalSoundsDir();
  std::error_code ec;
  if (!fileName.empty()) {
    fs::path candidate = soundsDir / fs::path(toWide(fileName)).filename();
    if (fs::exists(candidate, ec) && fs::is_regular_file(candidate, ec) && fs::file_size(candidate, ec) > 0) {
      storedFileName = candidate.filename().string();
      return candidate;
    }
  }
  // Downloads and imports can change the safe filename. Recover the matching
  // file by its display name instead of treating an old saved filename as lost.
  auto keyForMatch = [](std::string value) {
    std::string key;
    key.reserve(value.size());
    for (unsigned char ch : value) {
      if (std::isalnum(ch)) key.push_back(static_cast<char>(std::tolower(ch)));
    }
    return key;
  };
  const std::string requestedName = keyForMatch(soundName);
  const std::string requestedFile = keyForMatch(fs::path(toWide(fileName)).stem().string());
  fs::path recovered;
  size_t recoveredScore = 0;
  std::vector<fs::path> searchDirs{soundsDir};
  wchar_t* appData = nullptr;
  if (_wdupenv_s(&appData, nullptr, L"APPDATA") == 0 && appData) {
    searchDirs.push_back(fs::path(appData) / L"DiscordUnlock" / L"sons");
    free(appData);
  }
  for (const auto& directory : searchDirs) {
    if (!fs::exists(directory, ec)) continue;
    for (const auto& entry : fs::directory_iterator(directory, fs::directory_options::skip_permission_denied, ec)) {
      if (!entry.is_regular_file(ec) || entry.file_size(ec) == 0) continue;
      std::string extension = entry.path().extension().string();
      for (char& ch : extension) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
      if (extension != ".mp3" && extension != ".wav" && extension != ".ogg" && extension != ".m4a") continue;
      const std::string actual = keyForMatch(entry.path().stem().string());
      if (actual.empty()) continue;
      size_t score = 0;
      for (const auto* requested : {&requestedName, &requestedFile}) {
        if (requested->empty()) continue;
        if (actual == *requested) score = (std::max)(score, requested->size() + 100000);
        else if (actual.find(*requested) != std::string::npos || requested->find(actual) != std::string::npos)
          score = (std::max)(score, (std::min)(actual.size(), requested->size()));
      }
      if (score > recoveredScore) { recovered = entry.path(); recoveredScore = score; }
    }
  }
  if (!recovered.empty()) {
    storedFileName = recovered.filename().string();
    return recovered;
  }

  const size_t comma = dataUrl.find(',');
  if (comma == std::string::npos || dataUrl.rfind("data:audio/", 0) != 0) {
    error = "O arquivo local deste som nao foi encontrado.";
    return {};
  }
  const std::string bytes = base64Decode(dataUrl.substr(comma + 1));
  if (bytes.empty()) {
    error = "O arquivo de audio esta vazio ou corrompido.";
    return {};
  }
  const std::string mime = dataUrl.substr(0, comma);
  const std::string extension = mime.find("wav") != std::string::npos ? ".wav" : ".mp3";
  const std::string baseName = sanitizeFilename(soundName.empty() ? soundId : soundName);
  fs::path destination = soundsDir / fs::path(toWide(baseName + "_" + soundId + extension)).filename();
  std::ofstream output(destination, std::ios::binary | std::ios::trunc);
  if (!output.is_open()) {
    error = "Nao foi possivel salvar o som na pasta local.";
    return {};
  }
  output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
  output.close();
  if (!output.good()) {
    fs::remove(destination, ec);
    error = "Falha ao preparar o arquivo para reproducao.";
    return {};
  }
  storedFileName = destination.filename().string();
  return destination;
}

uint64_t getSoundboardDurationMs(const fs::path& sourceFile) {
  std::error_code ec;
  if (!fs::exists(sourceFile, ec)) return 0;
  HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitializeCom = SUCCEEDED(coHr);
  HRESULT mfHr = MFStartup(MF_VERSION);
  IMFSourceReader* reader = nullptr;
  PROPVARIANT durationValue;
  PropVariantInit(&durationValue);
  uint64_t durationMs = 0;
  if (SUCCEEDED(mfHr) && SUCCEEDED(MFCreateSourceReaderFromURL(sourceFile.c_str(), nullptr, &reader)) && reader &&
      SUCCEEDED(reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &durationValue))) {
    if (durationValue.vt == VT_UI8) durationMs = durationValue.uhVal.QuadPart / 10000ULL;
    else if (durationValue.vt == VT_I8 && durationValue.hVal.QuadPart > 0) durationMs = static_cast<uint64_t>(durationValue.hVal.QuadPart) / 10000ULL;
  }
  PropVariantClear(&durationValue);
  if (reader) reader->Release();
  if (SUCCEEDED(mfHr)) MFShutdown();
  if (uninitializeCom) CoUninitialize();
  return durationMs;
}
fs::path createSoundboardTestTone() {
  fs::path outputPath = getLocalSoundsDir() / L"DiscordUnlock_Teste_Cable.wav";
  constexpr uint32_t sampleRate = 48000;
  constexpr uint16_t channels = 2;
  constexpr uint16_t bits = 16;
  constexpr uint32_t frames = 33600;
  constexpr uint32_t dataSize = frames * channels * (bits / 8);
  constexpr uint32_t riffSize = 36 + dataSize;
  constexpr uint32_t byteRate = sampleRate * channels * (bits / 8);
  constexpr uint16_t blockAlign = channels * (bits / 8);
  std::ofstream out(outputPath, std::ios::binary | std::ios::trunc);
  if (!out.is_open()) return {};
  auto w16 = [&out](uint16_t value) { out.write(reinterpret_cast<const char*>(&value), sizeof(value)); };
  auto w32 = [&out](uint32_t value) { out.write(reinterpret_cast<const char*>(&value), sizeof(value)); };
  out.write("RIFF", 4); w32(riffSize); out.write("WAVE", 4);
  out.write("fmt ", 4); w32(16); w16(1); w16(channels); w32(sampleRate); w32(byteRate); w16(blockAlign); w16(bits);
  out.write("data", 4); w32(dataSize);
  for (uint32_t i = 0; i < frames; ++i) {
    const double fade = (std::min)(1.0, (std::min)(static_cast<double>(i) / 2400.0, static_cast<double>(frames - i) / 2400.0));
    const int16_t sample = static_cast<int16_t>(std::sin(6.283185307179586 * 880.0 * i / sampleRate) * 7200.0 * fade);
    w16(static_cast<uint16_t>(sample));
    w16(static_cast<uint16_t>(sample));
  }
  out.close();
  return outputPath;
}

#pragma pack(push, 1)
struct ClownfishPcmWaveHeader {
  char riff[4] = {'R', 'I', 'F', 'F'};
  uint32_t fileSize = 0;
  char wave[4] = {'W', 'A', 'V', 'E'};
  char fmt[4] = {'f', 'm', 't', ' '};
  uint32_t fmtSize = 16;
  uint16_t formatTag = 1;
  uint16_t channels = 2;
  uint32_t sampleRate = 48000;
  uint32_t averageBytesPerSecond = 192000;
  uint16_t blockAlign = 4;
  uint16_t bitsPerSample = 16;
  char data[4] = {'d', 'a', 't', 'a'};
  uint32_t dataSize = 0;
};
#pragma pack(pop)

// Clownfish' player is less tolerant than Media Foundation with some MP3 encodings.
// Send it a cached PCM WAV while the local monitor keeps using the original file.
fs::path makeClownfishCompatibleAudio(const fs::path& sourceFile) {
  std::error_code ec;
  if (!fs::exists(sourceFile, ec) || fs::file_size(sourceFile, ec) == 0) return sourceFile;

  const uint64_t fileSize = fs::file_size(sourceFile, ec);
  const auto modified = fs::last_write_time(sourceFile, ec).time_since_epoch().count();
  const size_t key = std::hash<std::wstring>{}(sourceFile.wstring() + L"|" + std::to_wstring(fileSize) + L"|" + std::to_wstring(modified));
  const fs::path cacheDir = getLocalSoundsDir() / L"clownfish_pcm";
  fs::create_directories(cacheDir, ec);
  const fs::path outputFile = cacheDir / (L"cf_" + std::to_wstring(key) + L".wav");
  if (fs::exists(outputFile, ec) && fs::file_size(outputFile, ec) > sizeof(ClownfishPcmWaveHeader)) return outputFile;

  HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitializeCom = SUCCEEDED(coHr);
  HRESULT mfHr = MFStartup(MF_VERSION);
  if (FAILED(mfHr)) { if (uninitializeCom) CoUninitialize(); return sourceFile; }

  IMFSourceReader* reader = nullptr;
  IMFMediaType* pcmType = nullptr;
  IMFMediaType* actualType = nullptr;
  IMFSample* sample = nullptr;
  IMFMediaBuffer* buffer = nullptr;
  bool success = false;
  uint64_t written = 0;
  ClownfishPcmWaveHeader header{};
  const fs::path partialFile = outputFile.wstring() + L".partial";
  std::ofstream output(partialFile, std::ios::binary | std::ios::trunc);

  do {
    if (!output.is_open()) break;
    output.write(reinterpret_cast<const char*>(&header), sizeof(header));
    if (FAILED(MFCreateSourceReaderFromURL(sourceFile.c_str(), nullptr, &reader)) || !reader) break;
    reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    if (FAILED(reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE))) break;
    if (FAILED(MFCreateMediaType(&pcmType)) || !pcmType) break;
    pcmType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    pcmType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
    pcmType->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, 2);
    pcmType->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000);
    pcmType->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
    pcmType->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, 4);
    pcmType->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 192000);
    if (FAILED(reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, pcmType))) break;
    if (FAILED(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, &actualType)) || !actualType) break;
    UINT32 value = 0;
    if (SUCCEEDED(actualType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &value)) && value > 0) header.channels = static_cast<uint16_t>(value);
    if (SUCCEEDED(actualType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &value)) && value > 0) header.sampleRate = value;
    if (SUCCEEDED(actualType->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &value)) && value > 0) header.bitsPerSample = static_cast<uint16_t>(value);
    header.blockAlign = static_cast<uint16_t>(header.channels * header.bitsPerSample / 8);
    header.averageBytesPerSecond = header.sampleRate * header.blockAlign;

    for (;;) {
      DWORD stream = 0, flags = 0;
      LONGLONG timestamp = 0;
      sample = nullptr;
      if (FAILED(reader->ReadSample(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, &stream, &flags, &timestamp, &sample))) break;
      if (sample) {
        if (SUCCEEDED(sample->ConvertToContiguousBuffer(&buffer)) && buffer) {
          BYTE* bytes = nullptr;
          DWORD maxBytes = 0, currentBytes = 0;
          if (SUCCEEDED(buffer->Lock(&bytes, &maxBytes, &currentBytes)) && bytes && currentBytes) {
            output.write(reinterpret_cast<const char*>(bytes), currentBytes);
            written += currentBytes;
            buffer->Unlock();
          }
          buffer->Release();
          buffer = nullptr;
        }
        sample->Release();
        sample = nullptr;
      }
      if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { success = written > 0; break; }
    }
  } while (false);

  if (buffer) buffer->Release();
  if (sample) sample->Release();
  if (actualType) actualType->Release();
  if (pcmType) pcmType->Release();
  if (reader) reader->Release();
  MFShutdown();
  if (uninitializeCom) CoUninitialize();
  output.close();

  if (!success || written > 0xFFFFFFFFull) {
    fs::remove(partialFile, ec);
    return sourceFile;
  }
  header.dataSize = static_cast<uint32_t>(written);
  header.fileSize = header.dataSize + sizeof(ClownfishPcmWaveHeader) - 8;
  std::fstream finalize(partialFile, std::ios::binary | std::ios::in | std::ios::out);
  if (!finalize.is_open()) { fs::remove(partialFile, ec); return sourceFile; }
  finalize.write(reinterpret_cast<const char*>(&header), sizeof(header));
  finalize.close();
  fs::rename(partialFile, outputFile, ec);
  if (ec || !fs::exists(outputFile, ec)) { fs::remove(partialFile, ec); return sourceFile; }
  return outputFile;
}
void postClownfishStatus() {
  const bool installed = DiscordUnlock::ClownfishBridge::IsInstalled();
  // Do not probe or start any audio component on machines where the optional
  // Clownfish integration was never installed.
  if (!installed) {
    postJsonToUI("{\"type\":\"clownfish_status\",\"installed\":false,\"running\":false,\"filterAttached\":false}");
    return;
  }
  const bool running = DiscordUnlock::ClownfishBridge::IsRunning();
  const bool filterAttached = DiscordUnlock::ClownfishBridge::HasAudioFilterAttached();
  postJsonToUI("{\"type\":\"clownfish_status\",\"installed\":true,\"running\":" + std::string(running ? "true" : "false") +
               ",\"filterAttached\":" + std::string(filterAttached ? "true" : "false") + "}");
}

int clownfishVoiceId(const std::string& preset) {
  if (preset == "alien") return 1;
  if (preset == "female" || preset == "anime_girl") return 9;
  if (preset == "kid" || preset == "mickey" || preset == "chipmunk") return 11;
  if (preset == "deep_voice" || preset == "alpha_male" || preset == "darth_vader" || preset == "batman") return 8;
  if (preset == "radio") return 12;
  if (preset == "robot" || preset == "optimus") return 13;
  if (preset == "underwater" || preset == "space_echo" || preset == "cathedral") return 3;
  if (preset == "ghostface") return 4;
  return 0;
}

// Soundpad uses the same Clownfish engine as voice effects. Keep both states
// independent so starting Soundpad cannot restore a previously selected filter.
static bool clownfishVoiceEffectsEnabled = false;

void handleClownfishAction(const std::string& action, const std::string& json) {
  std::string error;
  if (action == "clownfish_status") { postClownfishStatus(); return; }
  if (action == "clownfish_start") {
    const bool ok = DiscordUnlock::ClownfishBridge::Start(error);
    postJsonToUI("{\"type\":\"clownfish_result\",\"success\":" + std::string(ok ? "true" : "false") + ",\"error\":\"" + escapeJsonString(error) + "\"}");
    postClownfishStatus();
    return;
  }
  if (action == "clownfish_autorepair") {
    bool needsSetup = false;
    bool restarted = false;
    const bool ok = DiscordUnlock::ClownfishBridge::AutoRepair(error, &needsSetup, &restarted);
    postJsonToUI("{\"type\":\"clownfish_result\",\"repairing\":true,\"needsSetup\":" +
                 std::string(needsSetup ? "true" : "false") + ",\"restarted\":" +
                 std::string(restarted ? "true" : "false") + ",\"success\":" +
                 std::string(ok ? "true" : "false") + ",\"error\":\"" + escapeJsonString(error) + "\"}");
    postClownfishStatus();
    return;
  }
  // Start and validate in one native action so the first sound cannot race a
  // muted or frozen audio engine. Machines without Clownfish are skipped.
  if (action == "clownfish_prepare_soundpad") {
    int gain = 100;
    try { gain = static_cast<int>(std::lround(std::stof(extractJsonField(json, "gain")) * 100.0f)); } catch (...) {}
    gain = (std::max)(0, (std::min)(100, gain));
    if (!DiscordUnlock::ClownfishBridge::IsInstalled()) { postClownfishStatus(); return; }
    clownfishVoiceEffectsEnabled = false;
    bool correctedMutedVolume = false;
    bool restartedEngine = false;
    const bool ok = DiscordUnlock::ClownfishBridge::EnsureSoundboardReady(gain, true, error, &correctedMutedVolume, &restartedEngine);
    if (correctedMutedVolume) postJsonToUI("{\"type\":\"toast\",\"message\":\"Volume do motor de áudio estava zerado e foi corrigido.\"}");
    if (restartedEngine) postJsonToUI("{\"type\":\"toast\",\"message\":\"Motor de áudio sem resposta foi reiniciado automaticamente.\"}");
    postJsonToUI("{\"type\":\"clownfish_result\",\"success\":" + std::string(ok ? "true" : "false") + ",\"error\":\"" + escapeJsonString(error) + "\"}");
    postClownfishStatus();
    return;
  }
  if (action == "clownfish_install") {
    std::thread([]() {
      std::string installError;
      const bool ok = DiscordUnlock::ClownfishBridge::InstallOfficial(installError);
      postJsonToUI("{\"type\":\"clownfish_result\",\"success\":" + std::string(ok ? "true" : "false") + ",\"installing\":true,\"error\":\"" + escapeJsonString(installError) + "\"}");
    }).detach();
    return;
  }
  if (action == "clownfish_uninstall") {
    std::thread([]() {
      std::string uninstallError;
      const bool ok = DiscordUnlock::ClownfishBridge::UninstallOfficial(uninstallError);
      postJsonToUI("{\"type\":\"clownfish_result\",\"success\":" + std::string(ok ? "true" : "false") + ",\"uninstalling\":true,\"error\":\"" + escapeJsonString(uninstallError) + "\"}");
    }).detach();
    return;
  }
  if (action == "clownfish_set_enabled") {
    clownfishVoiceEffectsEnabled = (extractJsonField(json, "enabled") == "true" || extractJsonField(json, "enabled") == "1");
    bool ok = true;
    if (clownfishVoiceEffectsEnabled) {
      ok = DiscordUnlock::ClownfishBridge::Start(error);
      if (ok) ok = DiscordUnlock::ClownfishBridge::Send("2|1", error);
    } else {
      // Leave the playback engine available for Soundpad, while guaranteeing
      // the physical microphone is back to the neutral, unfiltered preset.
      ok = DiscordUnlock::ClownfishBridge::Send("3|0", error);
    }
    if (!ok) postJsonToUI("{\"type\":\"clownfish_result\",\"success\":false,\"error\":\"" + escapeJsonString(error) + "\"}");
    return;
  }
  if (action == "clownfish_set_voice") {
    const int requestedVoice = clownfishVoiceId(extractJsonField(json, "preset"));
    const int activeVoice = clownfishVoiceEffectsEnabled ? requestedVoice : 0;
    const bool ok = DiscordUnlock::ClownfishBridge::Send("3|" + std::to_string(activeVoice), error);
    if (!ok) postJsonToUI("{\"type\":\"clownfish_result\",\"success\":false,\"error\":\"" + escapeJsonString(error) + "\"}");
    return;
  }
}

void handleNativeSoundboardAction(const std::string& action, const std::string& json) {
  auto complete = [](const std::string& soundId, const std::string& storedFileName, bool success,
                     const std::string& error, uint64_t durationMs = 0, const std::string& state = "ready") {
    postJsonToUI("{\"type\":\"soundboard_native_result\",\"soundId\":\"" + escapeJsonString(soundId) +
                 "\",\"fileName\":\"" + escapeJsonString(storedFileName) + "\",\"success\":" +
                 (success ? "true" : "false") + ",\"durationMs\":" + std::to_string(durationMs) +
                 ",\"state\":\"" + escapeJsonString(state) + "\",\"error\":\"" + escapeJsonString(error) + "\"}");
  };
  std::string error;
  if (action == "soundboard_import_native") {
    const std::string soundId = extractJsonField(json, "soundId");
    const std::string soundName = extractJsonField(json, "name");
    const std::string dataUrl = extractJsonField(json, "dataUrl");
    std::thread([soundId, soundName, dataUrl, complete]() {
      std::string importError, storedFileName;
      const fs::path filePath = materializeSoundboardFile(soundId, soundName, "", dataUrl, storedFileName, importError);
      complete(soundId, storedFileName, !filePath.empty(), importError);
    }).detach();
    return;
  }
  if (action == "soundboard_stop_native" || action == "soundboard_stop_all_native") {
    if (action == "soundboard_stop_all_native") DiscordUnlock::NativeSoundboardEngine::Instance().StopAll();
    else DiscordUnlock::NativeSoundboardEngine::Instance().Stop(extractJsonField(json, "soundId") + "__monitor");
    DiscordUnlock::ClownfishBridge::Send("0|", error);
    return;
  }
  if (action == "soundboard_set_gain_native") {
    int gain = 100;
    try { gain = static_cast<int>(std::lround(std::stof(extractJsonField(json, "gain")) * 100.0f)); } catch (...) {}
    gain = (std::max)(0, (std::min)(100, gain));
    DiscordUnlock::NativeSoundboardEngine::Instance().SetGainForAll(static_cast<float>(gain) / 100.0f);
    if (!DiscordUnlock::ClownfishBridge::IsInstalled()) return;
    bool correctedMutedVolume = false;
    bool restartedEngine = false;
    DiscordUnlock::ClownfishBridge::EnsureSoundboardReady(gain, false, error, &correctedMutedVolume, &restartedEngine);
    if (correctedMutedVolume) postJsonToUI("{\"type\":\"toast\",\"message\":\"Volume do motor de áudio estava zerado e foi corrigido.\"}");
    if (restartedEngine) postJsonToUI("{\"type\":\"toast\",\"message\":\"Motor de áudio reiniciado automaticamente.\"}");
    return;
  }

  const std::string soundId = action == "soundboard_test_native" ? "__clownfish_test" : extractJsonField(json, "soundId");
  fs::path filePath;
  std::string storedFileName;
  if (action == "soundboard_test_native") {
    filePath = createSoundboardTestTone();
    if (!filePath.empty()) storedFileName = filePath.filename().string();
    else error = "Nao foi possivel criar o audio de teste.";
  } else {
    filePath = materializeSoundboardFile(soundId, extractJsonField(json, "name"), extractJsonField(json, "fileName"), extractJsonField(json, "dataUrl"), storedFileName, error);
  }
  if (filePath.empty()) { complete(soundId, storedFileName, false, error); return; }
  float gain = 1.0f;
  try { gain = std::stof(extractJsonField(json, "gain")); } catch (...) {}
  gain = (std::max)(0.0f, (std::min)(1.0f, gain));

  const uint64_t durationMs = getSoundboardDurationMs(filePath);
  // Reprodução única: encerra o monitor e o player de transmissão antes de iniciar o próximo som.
  DiscordUnlock::NativeSoundboardEngine::Instance().StopAll();
  std::string clownfishError;
  DiscordUnlock::ClownfishBridge::Send("0|", clownfishError);

  // Prepare transmission first: hearing the local monitor is not proof that
  // the Clownfish player received the sound. Restore gain after every restart.
  const fs::path transmissionFile = makeClownfishCompatibleAudio(filePath);
  bool correctedMutedVolume = false;
  bool restartedEngine = false;
  bool transmitted = DiscordUnlock::ClownfishBridge::EnsureSoundboardReady(
      static_cast<int>(std::lround(gain * 100.0f)), !clownfishVoiceEffectsEnabled, clownfishError,
      &correctedMutedVolume, &restartedEngine);
  if (transmitted && !clownfishVoiceEffectsEnabled) {
    transmitted = DiscordUnlock::ClownfishBridge::Send("4|0", clownfishError);
    if (transmitted) transmitted = DiscordUnlock::ClownfishBridge::Send("6|disable", clownfishError);
  }
  if (correctedMutedVolume) postJsonToUI("{\"type\":\"toast\",\"message\":\"Volume do motor de áudio estava zerado e foi corrigido.\"}");
  if (restartedEngine) postJsonToUI("{\"type\":\"toast\",\"message\":\"Motor de áudio reiniciado automaticamente antes da reprodução.\"}");
  if (transmitted) transmitted = DiscordUnlock::ClownfishBridge::Send(
      "0|" + toUtf8(transmissionFile.wstring()), clownfishError);
  if (!transmitted) {
    error = "O audio nao foi enviado ao motor do microfone. " + clownfishError;
    complete(soundId, storedFileName, false, error, durationMs, "started");
    return;
  }
  DiscordUnlock::NativeSoundboardEngine::Instance().Play(
      soundId + "__monitor", filePath.wstring(), L"default", gain,
      [soundId, storedFileName, durationMs, complete](bool success, const std::string& playbackError) {
        complete(soundId, storedFileName, success, playbackError, durationMs, "ended");
      });
  complete(soundId, storedFileName, true, "", durationMs, "started");
}
