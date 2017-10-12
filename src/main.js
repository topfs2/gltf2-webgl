'use strict';

const GLTF2Scene = require('./scenes/GLTF2Scene');

const scene = GLTF2Scene();

const DEBUG_GLOBAL_GL = true;

const setup = () => {
    scene.init(gl, viewportWidth, viewportHeight);

    const animate = () => {
        scene.render(gl);
        requestAnimationFrame(animate);
    };

    animate();
};

const canvas = document.createElement('canvas');
const viewportWidth = canvas.width = window.innerWidth;
const viewportHeight = canvas.height = window.innerHeight;
document.body.appendChild(canvas);

const webgl2 = false;
const gl = webgl2 ? canvas.getContext( 'webgl2', { antialias: false } ) : canvas.getContext('webgl');

if(!!!gl) {
    const name = 'WeblGL' + webgl2 ? ' 2' : '';
    document.getElementById('info').innerHTML = `${name} is not available.  See <a href="https://www.khronos.org/webgl/wiki/Getting_a_WebGL_Implementation">How to get a ${name} implementation</a>`;
} else {
    gl.isWebGL2 = webgl2;

    console.log('WebGL2', webgl2);

    if (DEBUG_GLOBAL_GL) {
        window.gl = gl;
    }

    scene.load(gl).then(setup, err => {
        console.error('Failed to load scene', err);
    });
}
