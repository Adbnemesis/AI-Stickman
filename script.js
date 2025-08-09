
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// Example simple game loop placeholder
let shipX = canvas.width / 2;
let shipY = canvas.height - 100;

function drawShip() {
    ctx.fillStyle = 'white';
    ctx.fillRect(shipX - 25, shipY - 25, 50, 50);
}

function gameLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawShip();
    requestAnimationFrame(gameLoop);
}

gameLoop();
