const fs=require('fs');
const p='game.js';
const lines=fs.readFileSync(p,'utf8').split('\n');
const keys=['runSteamIntroCapture','runTrailerIntroCapture','maybeStartSteamBatchCapture','maybeStartTrailerBatchCapture','RonkIntroAnimation.start'];
lines.forEach((l,i)=>{ if(keys.some(k=>l.includes(k))) console.log(i+1+':'+l.trim().slice(0,120)); });
