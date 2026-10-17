"""Re-extract everything from the installed game and rebuild the site data.

Usage: python tools/update.py [--game "<Alchemy Factory install dir>"] [--skip-icons]
Run this after every game update.
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, 'work')
SITE = os.path.join(ROOT, 'site')
TOOLS = os.path.join(ROOT, 'tools')
EXTRACTOR = os.path.join(ROOT, 'extractor')
DEFAULT_GAME = r'C:\Program Files (x86)\Steam\steamapps\common\Alchemy Factory'
ICON_DIRS = [
    'AlchemyFactory/Content/Arts/UI/Ingredients/',
    'AlchemyFactory/Content/Arts/UI/Buildings/',
    'AlchemyFactory/Content/Arts/UI/Furnitures/',
    'AlchemyFactory/Content/Arts/UI/Interaction/T_UI_Upgrade',
]
VERSION_ASSET = 'AlchemyFactory/Content/Blueprints/WBP/NetSession/WBP_NetSessionMain.uasset'


def step(msg):
    print(f'\n== {msg}', flush=True)


def run(cmd, **kw):
    print('  $', ' '.join(cmd[:4]), '...' if len(cmd) > 4 else '', flush=True)
    return subprocess.run(cmd, check=True, **kw)


def extractor(args, env):
    dll = os.path.join(EXTRACTOR, 'bin', 'Release', 'net10.0', 'extractor.dll')
    return run(['dotnet', dll] + args, env=env, capture_output=True, text=True, encoding='utf-8').stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', default=DEFAULT_GAME)
    ap.add_argument('--skip-icons', action='store_true')
    a = ap.parse_args()
    exe = os.path.join(a.game, 'AlchemyFactory', 'Binaries', 'Win64', 'AlchemyFactory-Win64-Shipping.exe')
    os.makedirs(WORK, exist_ok=True)

    step('Rebuilding type mappings from the game exe')
    usmap = os.path.join(WORK, 'AlchemyFactory.usmap')
    run([sys.executable, os.path.join(TOOLS, 'dump_usmap.py'), exe, usmap, os.path.join(WORK, 'schema.json')],
        stderr=subprocess.DEVNULL)

    step('Building extractor')
    run(['dotnet', 'build', EXTRACTOR, '-c', 'Release', '-v', 'q', '-nologo'], stdout=subprocess.DEVNULL)

    env = dict(os.environ, AF_USMAP=usmap, AF_PAKS=os.path.join(a.game, 'AlchemyFactory', 'Content', 'Paks'))
    step('Listing game files')
    files = extractor(['list'], env).splitlines()
    open(os.path.join(WORK, 'files.txt'), 'w', encoding='utf-8').write('\n'.join(files))

    for sub, pattern in (('dump', r'^AlchemyFactory/Content/DataTables/.*\.uasset$'),
                         ('dump_bp', r'^AlchemyFactory/Content/Blueprints/Buildings/.*\.uasset$')):
        step(f'Exporting {sub}')
        out = os.path.join(WORK, sub)
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        paths = sorted({f for f in files if re.match(pattern, f)})
        log = extractor(['json', out] + paths, env)
        fails = [l for l in log.splitlines() if l.startswith('FAIL')]
        print(f'  {len(paths) - len(fails)} ok, {len(fails)} failed')
        for l in fails:
            print('  ', l)

    step('Exporting localization')
    os.makedirs(os.path.join(WORK, 'loc'), exist_ok=True)
    extractor(['locres', os.path.join(WORK, 'loc')], env)

    if not a.skip_icons or not os.path.isdir(os.path.join(WORK, 'icons')):
        step('Exporting icons')
        shutil.rmtree(os.path.join(WORK, 'icons'), ignore_errors=True)
        extractor(['icons', os.path.join(WORK, 'icons')] + ICON_DIRS, env)

    step('Reading game version')
    raw_dir = os.path.join(WORK, 'raw')
    os.makedirs(raw_dir, exist_ok=True)
    extractor(['raw', raw_dir, VERSION_ASSET], env)
    blob = open(glob.glob(os.path.join(raw_dir, '*WBP_NetSessionMain.uasset'))[0], 'rb').read()
    m = re.search(rb'\b(\d+\.\d+\.\d{3,6})\b', blob)
    version = m.group(1).decode() if m else 'unknown'
    acf = glob.glob(os.path.join(a.game, '..', '..', 'appmanifest_3669570.acf'))
    if acf:
        b = re.search(r'"buildid"\s+"(\d+)"', open(acf[0], encoding='utf-8').read())
        if b:
            version += f' (Steam build {b.group(1)})'
    open(os.path.join(WORK, 'version.txt'), 'w', encoding='utf-8').write(version)
    print('  ', version)

    step('Building site data')
    run([sys.executable, os.path.join(TOOLS, 'build_data.py'), WORK, SITE])
    print('\nDone.')


if __name__ == '__main__':
    main()
