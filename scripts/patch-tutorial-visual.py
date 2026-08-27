from pathlib import Path

game_path = Path(__file__).resolve().parent.parent / "game.js"
s = game_path.read_text(encoding="utf-8")
start = s.index("function renderTutorialVisual(step)")
end = s.index("function shouldShowTutorialOverlay()", start)

lines = [
    "function renderTutorialVisual(step) {",
    "    const visual = document.getElementById('tutorial-visual');",
    "    if (!visual) return;",
    "    if (step >= TUTORIAL_FINAL_STEP) {",
    "        visual.classList.add('tutorial-visual-hidden');",
    "        visual.innerHTML = '';",
    "        return;",
    "    }",
    "    visual.classList.remove('tutorial-visual-hidden');",
    "    const demos = ['move', 'dash', 'charge', 'trails', 'travel', 'checkpoints', 'skills', 'hunger', 'minimap', 'fight'];",
    "    const demo = demos[step] || 'move';",
    '    const p1Cube = \'<div class="tutorial-demo-cube p1"></div>\';',
    '    const p2Cube = \'<motion class="tutorial-demo-cube p2"></div>\';',
    "    let demoContent = '';",
    "    switch (demo) {",
    "        case 'move':",
    "            demoContent = p1Cube;",
    "            break;",
    "        case 'dash':",
    "        case 'charge':",
    '            demoContent = `${p1Cube}<div class="tutorial-demo-trail"></div>`;',
    "            break;",
    "        case 'trails':",
    '            demoContent = `${p1Cube}${p2Cube}<div class="tutorial-demo-trail"></div>`;',
    "            break;",
    "        case 'travel':",
    '            demoContent = \'<div class="tutorial-demo-mini-map"><span></span><span></span><span class="lit"></span><span></span><span class="you"></span><span></span><span></span><span></span><span></span></div>\';',
    "            break;",
    "        case 'checkpoints':",
    '            demoContent = \'<div class="tutorial-demo-cp-stack"><span></span><span></span><span></span></div>\';',
    "            break;",
    "        case 'skills':",
    '            demoContent = `${p1Cube}<div class="tutorial-demo-clone a"></div><div class="tutorial-demo-clone b"></motion>`;',
    "            break;",
    "        case 'hunger':",
    '            demoContent = `${p1Cube}<div class="tutorial-demo-apple"></div><div class="tutorial-demo-hunger-bar"><div class="tutorial-demo-hunger-fill"></div></div>`;',
    "            break;",
    "        case 'minimap':",
    '            demoContent = \'<div class="tutorial-demo-mini-map"><span class="lit"></span><span></span><span class="lit"></span><span></span><span class="you"></span><span></span><span></span><span class="lit"></span><span></span></div>\';',
    "            break;",
    "        case 'fight':",
    "            demoContent = `${p1Cube}${p2Cube}`;",
    "            break;",
    "        default:",
    "            demoContent = p1Cube;",
    "    }",
    "    visual.innerHTML = `",
    '        <div class="tutorial-demo-grid"></div>',
    '        <div class="tutorial-demo-${demo}">',
    "            ${demoContent}",
    "        </div>`;",
    "}",
    "",
]

replacement = "\n".join(lines)
replacement = replacement.replace("<motion", "<div").replace("</motion>", "</div>")
game_path.write_text(s[:start] + replacement + s[end:], encoding="utf-8")
print("Patched renderTutorialVisual")
