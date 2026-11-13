/**
 * TERRITORY WALK - poster.js
 * Generate high-resolution weekly conquest archive images
 */

class PosterGenerator {
    constructor(appInstance) {
        this.app = appInstance;
    }

    async exportWeeklyPoster(gridTiles, team, nickname, weekId) {
        const width = 1200;
        const height = 1600;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // 1. Background
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, width, height);

        // 2. Title & Subtitle
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 64px sans-serif';
        ctx.fillText('TERRITORY WALK', 80, 120);

        ctx.fillStyle = '#71717a';
        ctx.font = '24px monospace';
        ctx.fillText('WEEKLY CONQUEST ARCHIVE // ' + weekId, 80, 160);

        // 3. Grid Visualization
        if (gridTiles && gridTiles.size > 0) {
            ctx.shadowBlur = 15;
            ctx.shadowColor = team === 'white' ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
            
            const entries = Array.from(gridTiles.entries());
            entries.forEach(([id, t], index) => {
                const x = 100 + (index % 10) * 100;
                const y = 300 + Math.floor(index / 10) * 100;
                if (y > 1300) return;
                ctx.fillStyle = t === team ? '#ffffff' : '#27272a';
                ctx.fillRect(x, y, 80, 80);
            });
            ctx.shadowBlur = 0;
        }

        // 4. Footer Information
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px sans-serif';
        ctx.fillText(`PLAYER: ${nickname}`, 80, 1450);
        ctx.fillText(`TEAM: ${team.toUpperCase()}`, 80, 1490);
        
        ctx.fillStyle = '#71717a';
        ctx.font = '20px monospace';
        ctx.fillText('Created for お絵描き楽しも委員会', 80, 1550);

        // 5. Output
        canvas.toBlob(async (blob) => {
            const file = new File([blob], 'territory-walk-archive.png', { type: 'image/png' });
            
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: 'Territory Walk', text: 'My weekly conquest!' });
                } catch (e) {
                    this.downloadBlob(blob);
                }
            } else {
                this.downloadBlob(blob);
            }
        });
    }

    downloadBlob(blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'territory-walk-week-archive.png';
        a.click();
        URL.revokeObjectURL(url);
    }
}
