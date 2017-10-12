const _ = require('lodash');

const DEBUG = true;
const DEBUG_UNIFORMS = false;

const getShader = (gl, source, type) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source.trim());
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        throw new Error(log);
    }

    return shader;
};

const Shader = function (gl, vs, fs, attributeLocations) {
    if (this === window || this === undefined) {
        return new Shader(vs, fs, attributeLocations);
    }

    if (DEBUG) {
        console.log('<vs>');
        console.log(vs);
        console.log('</vs>');

        console.log('<fs>');
        console.log(fs);
        console.log('</fs>');
    }

    const vertexShader = getShader(gl, vs, gl.VERTEX_SHADER);
    const fragmentShader = getShader(gl, fs, gl.FRAGMENT_SHADER);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    _.forEach(attributeLocations, (index, name) => {
        if (DEBUG) {
            console.log('bind attribute', name, index);
        }

        gl.bindAttribLocation(program, index, name)
    });

    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program);
        throw new Error(log);
    }

    this._gl = gl;
    this._program = program;

    this.vs = vs;
    this.fs = fs;
};

Shader.prototype.use = function () {
    this._gl.useProgram(this._program);
};

Shader.prototype.uniformLocation = function (name) {
    return this._gl.getUniformLocation(this._program, name);
};

Shader.prototype.attributeLocation = function (name) {
    return this._gl.getAttribLocation(this._program, name);
};

const BindUniformMethods = (matrix, methods) => {
    methods.forEach(method => {
        Shader.prototype[method] = function (name, u) {
            const gl = this._gl;
            const program = this._program;
            const loc = gl.getUniformLocation(program, name);

            if (loc) {
                if (matrix) {
                    gl[method](loc, false, u)
                } else {
                    gl[method](loc, u)
                }
            } else if (DEBUG_UNIFORMS) {
                console.log('No location for uniform', name, u);
            }
        }
    });
};

BindUniformMethods(false, [
    'uniform1i',
    'uniform1f',
    'uniform2fv',
    'uniform3fv',
    'uniform4fv'
]);

BindUniformMethods(true, [
    'uniformMatrix3fv',
    'uniformMatrix4fv'
]);


Shader.prototype.dispose = function () {
    this._gl.deleteProgram(this._program);
    delete this._program;
};

module.exports = Shader;
