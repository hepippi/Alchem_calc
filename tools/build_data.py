"""Turn the extracted game tables into site/data/gamedata.js for the calculator.

Usage: python build_data.py <workDir> <siteDir>
  workDir contains dump/ (DataTables), dump_bp/ (building blueprints), loc/ (locres json),
  icons/ (exported PNGs) and version.txt.
"""
import glob
import json
import os
import re
import sys

from PIL import Image

WORK, SITE = sys.argv[1], sys.argv[2]
ICON_SIZE = 64
LANGS = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'ko', 'de', 'fr', 'es', 'pt-BR', 'ru']


def table(name):
    path = glob.glob(os.path.join(WORK, 'dump', f'*_{name}.uasset.json'))[0]
    return json.load(open(path, encoding='utf-8'))[0]['Rows']


def enum_val(v):
    return v.split('::')[-1] if isinstance(v, str) else v


LOC = {lang: json.load(open(os.path.join(WORK, 'loc', f'{lang}.json'), encoding='utf-8')) for lang in LANGS}


def text(t):
    """FText (string table reference) -> {lang: string}."""
    if not isinstance(t, dict):
        return {}
    ns = t.get('TableId', '').split('.')[-1]
    key = t.get('Key')
    out = {}
    for lang in LANGS:
        for cand in (ns, ns.replace('_Names', ''), 'ST_Localization'):
            s = LOC[lang].get(cand, {}).get(key)
            if s:
                out[lang] = s
                break
    if not out and t.get('SourceString'):
        out['en'] = t['SourceString']
    return out


def loc_key(ns, key):
    return {lang: LOC[lang][ns][key] for lang in LANGS if LOC[lang].get(ns, {}).get(key)}


icon_dir = os.path.join(SITE, 'icons')
os.makedirs(icon_dir, exist_ok=True)


def icon(obj):
    """Texture reference -> site relative icon path (resized copy)."""
    if not isinstance(obj, dict):
        return None
    m = re.search(r"'([^']+)'", obj.get('ObjectName', ''))
    if not m:
        return None
    name = m.group(1)
    src = os.path.join(WORK, 'icons', name + '.png')
    if not os.path.exists(src):
        return None
    dst = os.path.join(icon_dir, name + '.png')
    if not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
        im = Image.open(src).convert('RGBA')
        im.thumbnail((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
        im.save(dst, optimize=True)
    return f'icons/{name}.png'


# ---------------------------------------------------------------- items
enemies = table('DT_Enemies')
items = {}
for iid, r in enemies.items():
    frac = -r['MaximumStack'] if r['MaximumStack'] < 0 else 1
    tags = [t.split('.')[-1] for t in r['IngredientTags']]
    items[iid] = {
        'name': text(r['DisplayName']),
        'icon': icon(r['DisplayIcon']),
        'tags': tags,
        'frac': frac,  # fractional items: recipe counts are 1/frac of an item
        'heat': r['HeatValue'] * frac,  # heat per whole item
        'nutrient': r['NutrientValue'],
        'nutrientSpeed': r['NutrientSpeed'],
        'liquid': r['IsLiquid'],
        'sell': enum_val(r['SellType']),
        'value': round(r['BaseCost'] * frac, 4),
        'hidden': r['bHideInGame'],
        'order': r['ID'],
    }
    if r['CauldronCost'] > 0 or r['CauldronMulti'] > 0:
        # cauldron: inputs add up `cost`; the output is the item whose `target` is nearest (weighted by `coef`)
        items[iid]['cauldron'] = {'cost': r['CauldronCost'], 'target': r['CauldronTarget'], 'coef': r['CauldronMulti']}
TAG_ALIAS = {'PlantSeed': 'Seed'}
tag_names = {}
for it in items.values():
    for t in it['tags']:
        tag_names.setdefault(t, loc_key('ST_Localization', f'Ingredient_Tag_{t}')
                             or loc_key('ST_Localization', f"Ingredient_Tag_{TAG_ALIAS.get(t, t)}"))


def qty(item_id, count):
    return count / items[item_id]['frac'] if item_id in items else count


# ---------------------------------------------------------------- recipes
recipes = []
for rid, r in table('DT_EnemyCrafting').items():
    ins = [{'item': i['IngredientName'], 'n': qty(i['IngredientName'], i['Count'])}
           for i in r['IngredientList'] if i['IngredientName'] != 'None' and i['Count'] > 0]
    main = r['ProductInfo']['IngredientName']
    fail = r['FailRate1'] + r['FailRate2']
    outs = [{'item': main, 'n': qty(main, r['ProductInfo']['Count']) * (1 - fail)}]
    for rate, prod in ((r['FailRate1'], r['FailProduct1']), (r['FailRate2'], r['FailProduct2'])):
        if rate > 0 and prod['Count'] > 0:
            outs.append({'item': prod['IngredientName'], 'n': qty(prod['IngredientName'], prod['Count']) * rate, 'p': rate})
    side = r['SideProduct']
    if side['Count'] > 0 and side['IngredientName'] != 'None':
        outs.append({'item': side['IngredientName'], 'n': qty(side['IngredientName'], side['Count'])})
    if fail > 0:
        outs[0]['p'] = 1 - fail
    rec = {
        'id': rid, 'main': main, 'type': enum_val(r['CraftType']), 'time': r['CraftingTime'],
        'in': ins, 'out': outs, 'alt': r['bAlternate'], 'hidden': r['bHideInGame'], 'order': r['ID'],
    }
    if r['CatalystCost']:
        rec['catalyst'] = {'cost': r['CatalystCost'], 'seq': r['ProductSequence'], 'unstable': r['UnstableSequence']}
    recipes.append(rec)
recipes.sort(key=lambda x: x['order'])

# plants: nutrient demand per harvested item (nursery mode)
plants = {}
for seed, p in table('DT_PlantSeedConfig').items():
    if p['PlantName'] == 'None' or seed not in items:
        continue
    plants[seed] = {
        'plant': p['PlantName'], 'side': None if p['SideProductName'] == 'None' else p['SideProductName'],
        'seconds': p['GrowthSeconds'], 'nutrientPerItem': p['GrowthNutrientValue'],
        'num': p['GrowthNum'], 'sideNum': p['SideGrowthNum'],
    }
# every growth cycle that yields an item (seed plants and World Tree stages): nutrients needed per harvested item
growth = [{
    'source': src, 'plant': p['PlantName'], 'side': None if p['SideProductName'] == 'None' else p['SideProductName'],
    'nutrientPerItem': p['GrowthNutrientValue'], 'num': p['GrowthNum'], 'sideNum': p['SideGrowthNum'],
    'seconds': p['GrowthSeconds'],
} for src, p in table('DT_PlantSeedConfig').items() if p['PlantName'] != 'None' and p['GrowthNutrientValue'] > 0]

# ---------------------------------------------------------------- machines
COMPONENT_DEFAULT = {  # component classes whose craft type is set in C++ rather than in the blueprint
    'ExtractFacilityComponent': 'Extract', 'ParadoxFacilityComponent': 'Paradox',
    'CauldronFacilityComponent': 'Cauldron', 'NurseryFacilityComponent': 'Nursery',
    'BuildingProduceComponent': 'TableSaw', 'CraftFacilityComponent': 'TableSaw', 'GrindFacilityComponent': 'TableSaw',
}
BP_DEFAULT = {'BP_SeedPlot': 'Plant', 'BP_TreeNursery': 'WorldTree'}
EXTRA_TYPES = {'AdvancedAthanor': ['Athanor']}  # Building_Desc_AdvancedAthanor2: also runs basic athanor recipes

bp_info = {}
for f in glob.glob(os.path.join(WORK, 'dump_bp', '*.json')):
    m = re.search(r'_(BP_[^.]+)\.uasset\.json$', f)
    if not m:
        continue
    bp = m.group(1)
    info = {}
    for e in json.load(open(f, encoding='utf-8')):
        props = e.get('Properties', {})
        t = e.get('Type', '')
        ct = props.get('FactoryType') or props.get('FactoryCraftType')
        if ct or t in COMPONENT_DEFAULT:
            info.setdefault('type', enum_val(ct) if ct else COMPONENT_DEFAULT[t])
        if 'GrindingSpeed' in props:
            info['speed'] = props['GrindingSpeed']
        if props.get('bThermal'):
            info['thermal'] = True
    if bp in BP_DEFAULT:
        info['type'] = BP_DEFAULT[bp]
    bp_info[bp] = info

machines = {}
seen_names = set()
for bid, b in table('DT_Buildings').items():
    m = re.search(r"'(BP_[^']+)_C'", (b.get('ScriptClass') or {}).get('ObjectName', ''))
    if not m or b['bHideInGame']:
        continue
    info = bp_info.get(m.group(1), {})
    if 'type' not in info:
        continue
    name = text(b['DisplayName'])
    key = (name.get('en'), info['type'])
    if key in seen_names:  # mirrored (_Sym) variants
        continue
    seen_names.add(key)
    machines[bid] = {
        'name': name, 'icon': icon(b['DisplayIcon']), 'types': [info['type']] + EXTRA_TYPES.get(bid, []),
        'heat': b['HeatCost'], 'speed': info.get('speed', 1.0), 'thermal': info.get('thermal', False),
        'order': b['ID'],
    }


# every placeable building (incl. mirrored/hidden variants used by blueprints): footprint and category
def building_category(b):
    tags = set(b['BuildingTags'])
    ft = enum_val(b['FurnitureType'])
    if 'Building.Crafting.Heating' in tags:
        return 'heat'
    if any(t.startswith('Building.Crafting.') for t in tags):
        return 'craft'
    if 'Building.Logistics.Storage' in tags or 'Building.Lab.Storage' in tags:
        return 'storage'
    if ft == 'Pipeline':
        return 'pipe'
    if ft == 'Railroad' or 'Building.Logistics.Track' in tags:
        return 'rail'
    if ft == 'Logistics' or 'Building.Logistics.Logistics' in tags or 'Building.Logistics.CargoLift' in tags:
        return 'belt'
    if 'Building.Logistics.Structure' in tags or ft in ('Construct', 'ConstructV2') or 'Building.Decoration.Blocks' in tags \
            or any(t.startswith('Building.Building.') for t in tags):
        return 'structure'
    if 'Building.Shop.Shelves' in tags or 'Building.Shop.Furniture' in tags:
        return 'shop'
    return 'deco'


buildings = {}
for bid, b in table('DT_Buildings').items():
    cells = set()
    for g in b['GridConfigList']:
        p = g['Position']
        cells.add((p['X'], p['Y'], p['Z']))
    for v in b['VolumeList']:
        for x in range(v['Min']['X'], v['Max']['X'] + 1):
            for y in range(v['Min']['Y'], v['Max']['Y'] + 1):
                for z in range(v['Min']['Z'], v['Max']['Z'] + 1):
                    cells.add((x, y, z))
    if not cells:
        cells = {(0, 0, 0)}
    m = re.search(r"'(BP_[^']+)_C'", (b.get('ScriptClass') or {}).get('ObjectName', ''))
    info = bp_info.get(m.group(1), {}) if m else {}
    entry = {
        'name': text(b['DisplayName']), 'icon': icon(b['DisplayIcon']), 'cat': building_category(b),
        'z0': min(c[2] for c in cells), 'h': max(c[2] for c in cells) - min(c[2] for c in cells) + 1,
        'heat': b['HeatCost'],
    }
    if 'type' in info:
        entry['craft'] = {'types': [info['type']] + EXTRA_TYPES.get(bid, []), 'speed': info.get('speed', 1.0)}
    buildings[bid] = entry

craft_types = {}
for r in recipes:
    craft_types.setdefault(r['type'], {'name': loc_key('ST_Localization', f"CraftType_Name_{r['type']}")})

# ---------------------------------------------------------------- research
attrs = table('DT_Attributes')
improvements = table('DT_Improvements')
RESEARCH = [  # (key, attribute, improvement row prefix)
    ('factory', 'FactorySpeed', 'FactorySpeed'),
    ('fuel', 'FuelEfficiency', 'FuelEfficiency'),
    ('fertilizer', 'FertilizerEfficiency', 'FertilizeEfficiency'),
    ('alchemy', 'ExtractorSkill', 'AlchemySkill'),
    ('logistics', 'ConveyerSpeed', 'Conveyer'),
    ('throwing', 'CatapultSpeed', 'ThrowingEfficiency'),
]
research = {}
for key, attr, prefix in RESEARCH:
    rows = sorted((r for k, r in improvements.items() if re.fullmatch(prefix + r'\d+', k)), key=lambda r: r['ImprovementLevel'])
    steps = [next(e['ModValue'] for e in r['Effects'] if e['AttributeName'] == attr) for r in rows]
    research[key] = {
        'name': text(rows[0]['DisplayName']), 'icon': icon(rows[0]['DisplayIcon']),
        'base': attrs[attr]['BaseValue'], 'steps': steps, 'repeat': rows[-1]['AllowRepeat'] or True,
    }

version = open(os.path.join(WORK, 'version.txt'), encoding='utf-8').read().strip()
data = {
    'version': version, 'langs': LANGS, 'items': items, 'recipes': recipes, 'machines': machines,
    'craftTypes': craft_types, 'plants': plants, 'growth': growth, 'research': research, 'tags': tag_names,
    'buildings': buildings,
}
os.makedirs(os.path.join(SITE, 'data'), exist_ok=True)
with open(os.path.join(SITE, 'data', 'gamedata.js'), 'w', encoding='utf-8') as f:
    f.write('window.GAME_DATA = ')
    json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')
print(f'items={len(items)} recipes={len(recipes)} machines={len(machines)} plants={len(plants)} version={version}')
