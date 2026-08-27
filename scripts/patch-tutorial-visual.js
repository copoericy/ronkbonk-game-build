const fs = require('fs');
const path = require('path');

const gamePath = path.join(__dirname, '..', 'game.js');
let s = fs.readFileSync(gamePath, 'utf8');

const start = s.indexOf('function renderTutorialVisual(step)');
const end = s.indexOf('function shouldShowTutorialOverlay()', start);
if (start === -1 || end === -1) {
    console.error('Could not find renderTutorialVisual block');
    process.exit(1);
}

const lines = [
    'function renderTutorialVisual(step) {',
    "    const visual = document.getElementById('tutorial-visual');",
    '    if (!visual) return;',
    '    if (step >= TUTORIAL_FINAL_STEP) {',
    "        visual.classList.add('tutorial-visual-hidden');",
    "        visual.innerHTML = '';",
    '        return;',
    '    }',
    "    visual.classList.remove('tutorial-visual-hidden');",
    "    const demos = ['move', 'dash', 'charge', 'trails', 'travel', 'checkpoints', 'skills', 'hunger', 'minimap', 'fight'];",
    "    const demo = demos[step] || 'move';",
    '    const p1Cube = \'<motion class="tutorial-demo-cube p1"></div>\';',
    '    const p2Cube = \'<div class="tutorial-demo-cube p2"></div>\';',
    "    let demoContent = '';",
    '    switch (demo) {',
    "        case 'move':",
    '            demoContent = p1Cube;',
    '            break;',
    "        case 'dash':",
    "        case 'charge':",
    '            demoContent = `${p1Cube}<div class="tutorial-demo-trail"></div>`;',
    '            break;',
    "        case 'trails':",
    '            demoContent = `${p1Cube}${p2Cube}<div class="tutorial-demo-trail"></motion>`;',
    '            break;',
    "        case 'travel':",
    '            demoContent = \'<div class="tutorial-demo-mini-map"><span></span><span></span><span class="lit"></span><span></span><span class="you"></span><span></span><span></span><span></span><span></span></div>\';',
    '            break;',
    "        case 'checkpoints':",
    '            demoContent = \'<div class="tutorial-demo-cp-stack"><span></span><span></span><span></span></div>\';',
    '            break;',
    "        case 'skills':",
    '            demoContent = `${p1Cube}<div class="tutorial-demo-clone a"></div><div class="tutorial-demo-clone b"></div>`;',
    '            break;',
    "        case 'hunger':",
    '            demoContent = `${p1Cube}<div class="tutorial-demo-apple"></div><div class="tutorial-demo-hunger-bar"><div class="tutorial-demo-hunger-fill"></div></div>`;',
    '            break;',
    "        case 'minimap':",
    '            demoContent = \'<div class="tutorial-demo-mini-map"><span class="lit"></span><span></span><span class="lit"></span><span></span><span class="you"></span><span></span><span></span><span class="lit"></span><span></span></div>\';',
    '            break;',
    "        case 'fight':",
    '            demoContent = `${p1Cube}${p2Cube}`;',
    '            break;',
    '        default:',
    '            demoContent = p1Cube;',
    '    }',
    '    visual.innerHTML = `',
    '        <div class="tutorial-demo-grid"></div>',
    '        <div class="tutorial-demo-${demo}">',
    '            ${demoContent}',
    '        </div>`;',
    '}',
    '',
];

let replacement = lines.join('\n');
replacement = replacement.replace(/<motion /g, '<div ').replace(/<\/motion>/g, '</div>');

fs.writeFileSync(gamePath, s.slice(0, start) + replacement + s.slice(end));
console.log('Patched renderTutorialVisual');
