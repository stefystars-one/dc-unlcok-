const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),cpp=fs.readFileSync(path.join(root,'gui_main.cpp'),'utf8');
const section=cpp.slice(cpp.indexOf('static std::string readDuVisualStateFile'),cpp.indexOf('static void startDuNetworkVisualSyncWatch'));
const extract=cpp.slice(cpp.indexOf('std::string extractJsonField(const std::string &json, const std::string &key) {'),cpp.indexOf('// =========================================================================',cpp.indexOf('std::string extractJsonField(const std::string &json, const std::string &key) {')));
const out=fs.mkdtempSync(path.join(root,'build-preview','native-sync-'));
const harness=String.raw`
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cctype>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <regex>
#include <string>
#include <vector>
namespace fs=std::filesystem;
#define MAX_PATH 260
static fs::path fixture;
static std::vector<std::string> requests;
static bool compatible = true;
int GetEnvironmentVariableW(const wchar_t*,wchar_t* output,int size) {const auto value=fixture.wstring();if(value.size()>=size)return 0;std::copy(value.begin(),value.end(),output);output[value.size()]=0;return (int)value.size();}
std::string getStoredLicenseKey(){return "TEST-ONLY-LICENSE";}
std::string cloudApiRequest(const std::wstring&,const std::wstring&,const std::string&){return compatible ? "{\"ok\":true,\"profileSyncProtocol\":2}" : "{}";}
std::string escapeJsonString(const std::string &value){return value;}
std::string postJsonToCloudApi(const std::wstring&,const std::string&payload){requests.push_back(payload);return "{\"ok\":true}";}
`+extract+section+String.raw`
void save(const char*name,const std::string&value){std::ofstream(fixture/"DiscordUnlock"/name)<<value;}
int main(int argc,char**argv){
 compatible = argc < 3;
 fixture=fs::absolute(argv[1]);fs::create_directories(fixture/"DiscordUnlock");
 save("current_discord_id.txt","111111111111111111");
 save("profile_banner.json",R"({"networkRefreshNonce":1})");
 syncDuNetworkVisualsOnce();assert(requests.empty());
 save("profile_banner.json",R"({"enabled": true,"bannerUrl":"https://i.imgur.com/banner.gif","avatarUrl":"https://i.imgur.com/avatar.gif","shareWithCommunity":false})");
 if (!compatible) {syncDuNetworkVisualsOnce();assert(requests.empty());std::cout<<"PASS old server blocks all automatic writes\n";return 0;}
 syncDuNetworkVisualsOnce();assert(requests.size()==1);assert(requests.back().find("\"customizations\"")==std::string::npos);assert(requests.back().find("\"shareWithCommunity\":false")!=std::string::npos);
 save("profile_banner.json",R"({"enabled": true,"bannerUrl":"https://i.imgur.com/banner.gif","avatarUrl":"https://i.imgur.com/avatar.gif","shareWithCommunity":false,"networkRefreshNonce":99,"height":200})");
 syncDuNetworkVisualsOnce();assert(requests.size()==1);
 save("applied_collectibles.json",R"({"avatarDecoration":{"asset":"a_test"}})");
 syncDuNetworkVisualsOnce();assert(requests.size()==2);assert(requests.back().find("\"bannerUrl\"")==std::string::npos);assert(requests.back().find("\"customizations\"")!=std::string::npos);
 save("applied_collectibles.json","{");
 syncDuNetworkVisualsOnce();assert(requests.size()==2);
 save("applied_collectibles.json","{}");
 syncDuNetworkVisualsOnce();assert(requests.size()==3);assert(requests.back().find("\"customizations\":{}")!=std::string::npos);
 save("profile_banner.json",R"({"enabled": false,"bannerUrl":"","avatarUrl":""})");
 syncDuNetworkVisualsOnce();assert(requests.size()==4);assert(requests.back().find("\"avatarUrl\":\"\"")!=std::string::npos);assert(requests.back().find("\"customizations\"")==std::string::npos);
 std::cout<<"PASS native watcher: notifications do not upload, partial files do not clear, changed domains only, privacy and explicit removals\n";
}
`;
fs.writeFileSync(path.join(out,'test.cpp'),harness);
const vs='C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/MSVC/14.51.36231';
const sdk='C:/Program Files (x86)/Windows Kits/10';
const args=['/nologo','/std:c++20','/MT','/EHsc','/utf-8','/I'+vs+'/include','/I'+sdk+'/Include/10.0.26100.0/ucrt','/I'+sdk+'/Include/10.0.26100.0/um','/I'+sdk+'/Include/10.0.26100.0/shared','test.cpp','/Fe:test.exe','/link','/LIBPATH:'+vs+'/lib/x64','/LIBPATH:'+sdk+'/Lib/10.0.26100.0/ucrt/x64','/LIBPATH:'+sdk+'/Lib/10.0.26100.0/um/x64'];
let result=cp.spawnSync(vs+'/bin/Hostx64/x64/cl.exe',args,{cwd:out,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
result=cp.spawnSync(path.join(out,'test.exe'),[path.join(out,'fixture')],{cwd:out,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
result=cp.spawnSync(path.join(out,'test.exe'),[path.join(out,'old-server-fixture'),'old'],{cwd:out,stdio:'inherit'});
process.exitCode=result.status||0;
