using Serilog;
﻿using CUE4Parse.Compression;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using Newtonsoft.Json;

Serilog.Log.Logger = new Serilog.LoggerConfiguration().MinimumLevel.Warning().WriteTo.Console(standardErrorFromLevel: Serilog.Events.LogEventLevel.Verbose).CreateLogger();

var GameDir = Environment.GetEnvironmentVariable("AF_PAKS") ?? @"C:\Program Files (x86)\Steam\steamapps\common\Alchemy Factory\AlchemyFactory\Content\Paks";
var mode = args.Length > 0 ? args[0] : "list";

var oodlePath = Path.Combine(AppContext.BaseDirectory, OodleHelper.OodleFileName);
await OodleHelper.InitializeAsync(oodlePath);

var provider = new DefaultFileProvider(GameDir, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_7));
var usmap = Environment.GetEnvironmentVariable("AF_USMAP");
if (!string.IsNullOrEmpty(usmap)) provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmap);
provider.Initialize();
provider.SubmitKey(new FGuid(), new FAesKey(new byte[32]));
provider.PostMount();

switch (mode)
{
    case "list":
        foreach (var f in provider.Files.Keys.OrderBy(x => x)) Console.WriteLine(f);
        break;
    case "json":
        // json <outDir> <path>...
        var outDir = args[1];
        foreach (var p in args.Skip(2))
        {
            try
            {
                var objs = provider.LoadPackage(p).GetExports();
                var json = JsonConvert.SerializeObject(objs, Formatting.Indented);
                var dst = Path.Combine(outDir, p.Replace('/', '_') + ".json");
                File.WriteAllText(dst, json);
                Console.WriteLine($"OK {p}");
            }
            catch (Exception e) { Console.WriteLine($"FAIL {p}: {e.Message}"); }
        }
        break;
    case "findname":
        // findname <needle> [pathPrefix]
        var prefix = args.Length > 2 ? args[2] : "AlchemyFactory/Content/";
        foreach (var f in provider.Files.Keys.Where(k => k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && k.EndsWith(".uasset")).OrderBy(x => x))
        {
            try
            {
                var data = provider.SaveAsset(f);
                if (data.AsSpan().IndexOf(System.Text.Encoding.ASCII.GetBytes(args[1])) >= 0) Console.WriteLine(f);
            }
            catch { }
        }
        break;
    case "names":
        foreach (var p in args.Skip(1))
        {
            var pkg = provider.LoadPackage(p);
            foreach (var n in (IEnumerable<dynamic>)((dynamic)pkg).NameMap) Console.WriteLine((string)n.Name);
        }
        break;
    case "locres":
        // locres <outDir> : dumps every Game.locres as {namespace: {key: text}}
        foreach (var f in provider.Files.Values.Where(f => f.Path.EndsWith("Game.locres", StringComparison.OrdinalIgnoreCase)))
        {
            var lang = Path.GetFileName(Path.GetDirectoryName(f.Path))!;
            var res = new CUE4Parse.UE4.Localization.FTextLocalizationResource(f.CreateReader());
            var dict = res.Entries.ToDictionary(
                ns => ns.Key.Str,
                ns => ns.Value.ToDictionary(e => e.Key.Str, e => e.Value.LocalizedString));
            File.WriteAllText(Path.Combine(args[1], $"{lang}.json"), JsonConvert.SerializeObject(dict, Formatting.Indented));
            Console.WriteLine($"OK {lang} {dict.Sum(d => d.Value.Count)}");
        }
        break;
    case "icons":
        // icons <outDir> <pathPrefix>... : exports every Texture2D under the prefixes as PNG
        Directory.CreateDirectory(args[1]);
        foreach (var pfx in args.Skip(2))
        {
            foreach (var f in provider.Files.Keys.Where(k => k.StartsWith(pfx, StringComparison.OrdinalIgnoreCase) && k.EndsWith(".uasset")).OrderBy(x => x))
            {
                try
                {
                    foreach (var obj in provider.LoadPackage(f).GetExports())
                    {
                        if (obj is not CUE4Parse.UE4.Assets.Exports.Texture.UTexture2D tex) continue;
                        var decoded = CUE4Parse_Conversion.Textures.TextureDecoder.Decode(tex);
                        if (decoded == null) { Console.WriteLine($"FAIL {f}: decode fmt={tex.Format} mips={tex.PlatformData?.Mips?.Length} first={tex.GetFirstMip()?.SizeX} bulk={tex.GetFirstMip()?.BulkData?.Data?.Length}"); continue; }
                        var png = CUE4Parse_Conversion.Textures.TextureEncoder.Encode(decoded, CUE4Parse_Conversion.Options.ETextureFormat.Png, false, out _, 100);
                        File.WriteAllBytes(Path.Combine(args[1], tex.Name + ".png"), png);
                    }
                }
                catch (Exception e) { Console.WriteLine($"FAIL {f}: {e.Message}"); }
            }
        }
        break;
    case "raw":
        // raw <outDir> <path>...
        foreach (var p in args.Skip(2))
        {
            var data = provider.SaveAsset(p);
            var dst = Path.Combine(args[1], p.Replace('/', '_'));
            File.WriteAllBytes(dst, data);
            Console.WriteLine($"OK {p} {data.Length}");
        }
        break;
}
