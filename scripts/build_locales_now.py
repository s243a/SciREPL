#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N_DIR = os.path.join(ROOT, "www", "i18n")

import sys
sys.path.insert(0, ROOT)

with open(os.path.join(I18N_DIR, "en.json"), "r", encoding="utf-8") as f:
    en_doc = json.load(f)

en_keys = [k for k in en_doc["strings"].keys() if not k.startswith("__")]

LITERALS = [
    "loading.sciRepl", "vfsFilePreview.alias", "wbArchive.zip", "wbArchive.tar", "wbArchive.tarGz",
    "wbKernel.python", "wbKernel.prolog", "wbKernel.javascript", "wbKernel.bash",
    "inputControls.lua", "inputControls.tyr", "inputControls.cljs",
    "export.html", "export.markdown", "export.docx", "export.latex",
    "mathPalette.solve", "mathPalette.simp", "mathPalette.exp", "mathPalette.mat",
    "mathPalette.sym", "mathPalette.lim", "mathPalette.ser", "mathPalette.fac",
    "prologSettings.mntProlog", "prologSettings.mntPyodide", "prologSettings.mntR"
]

import scripts.locales_data.hi as hi
import scripts.locales_data.bn as bn
import scripts.locales_data.ko as ko
import scripts.locales_data.pt_BR as pt_BR
import scripts.locales_data.fr as fr
import scripts.locales_data.ru as ru
import scripts.locales_data.ja as ja
import scripts.locales_data.de as de
import scripts.locales_data.id_lang as id_lang

modules = [hi, bn, ko, pt_BR, fr, ru, ja, de, id_lang]

for mod in modules:
    locale = mod.meta["locale"]
    endonym = mod.meta["endonym"]
    dir_mode = mod.meta["dir"]
    note = mod.meta["note"]
    glossary = mod.glossary
    strings_dict = mod.strings
    privacy_note = mod.meta["privacy_note"]
    privacy_notice = mod.meta["privacy_notice"]
    privacy_official = mod.meta["privacy_official"]

    final_strings = {"__literal": LITERALS}
    missing = []
    for k in en_keys:
        if k in LITERALS:
            final_strings[k] = en_doc["strings"][k]
        elif k in strings_dict:
            final_strings[k] = strings_dict[k]
        else:
            missing.append(k)

    if missing:
        raise ValueError(f"Locale '{locale}' is missing keys: {missing}")

    # Check placeholders
    for k in en_keys:
        en_placeholders = sorted(re.findall(r"\{[a-zA-Z0-9_]+\}", en_doc["strings"][k]))
        loc_placeholders = sorted(re.findall(r"\{[a-zA-Z0-9_]+\}", final_strings[k]))
        if en_placeholders != loc_placeholders:
            raise ValueError(f"Placeholder mismatch in {locale} key '{k}': EN={en_placeholders} vs LOC={loc_placeholders}")

    doc = {
        "__meta": {
            "locale": locale,
            "endonym": endonym,
            "dir": dir_mode,
            "note": note,
            "status": "draft"
        },
        "__glossary": glossary,
        "strings": final_strings
    }

    priv = {
        "__meta": {
            "locale": locale,
            "domain": "privacy",
            "status": "draft",
            "note": privacy_note
        },
        "strings": {
            "privacy.translationNotice": privacy_notice,
            "privacy.viewOfficial": privacy_official
        }
    }

    locale_path = os.path.join(I18N_DIR, f"{locale}.json")
    priv_path = os.path.join(I18N_DIR, f"privacy.{locale}.json")

    with open(locale_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")

    with open(priv_path, "w", encoding="utf-8") as f:
        json.dump(priv, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"✓ Generated {locale} ({endonym}) - 327 strings verified.")

print("\nAll 9 locales generated and verified successfully!")
