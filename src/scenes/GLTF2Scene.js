'use strict';

const { vec3, mat4 } = require('gl-matrix');
const _ = require('lodash');
const dat = require('dat.gui');

const Shader = require('../Shader');
const GLTF2Loader = require('../GLTF2Loader');
const ShaderLoader = require('../ShaderLoader');
const ImageLoader = require('../ImageLoader');

const getCurTimeMS = () => (new Date()).getTime();

const initialMS = getCurTimeMS();
const getTimeMS = () => getCurTimeMS() - initialMS;
const getTimeS = () => getTimeMS() / 1000;

const gui = new dat.GUI();
const conf = {
    useIBL: true,
    lights: 1,
    color0: [ 255, 255, 255 ],
    color1: [ 0, 128, 255 ],
    color2: [ 255, 0, 255 ]
};

gui.add(conf, 'useIBL');
gui.add(conf, 'lights', 0, 3).step(1);

gui.addColor(conf, 'color0');
gui.addColor(conf, 'color1');
gui.addColor(conf, 'color2');

const lightPositions = [
    vec3.fromValues(0, 5, 0),
    vec3.fromValues(-3, 5, 0),
    vec3.fromValues(3, 5, 0)
];


const radians = degrees => degrees * Math.PI / 180;

const accessorTypeSizes = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
};

const attributeLocations = {
    POSITION: 0,
    NORMAL: 1,
    TEXCOORD_0: 2
};

let first = true;
const logOnce = (...args) => {
    if (first) {
        console.log(...args);
    }
};

const accessorType2size = type => accessorTypeSizes[type];

const create = () => {

    /* GLTFS stuff */
    let gltf;
    let buffers;
    let images;

    let meshes = [];
    let cameras = [];
    let textures = [];

    /*  Pipeline stuff */
    let irradianceTexture;
    let radianceTexture;
    let brdfTexture;

    let haveLodSupport = false;
    let haveFloatSupport = false;

    function getBufferData (bufferN) {
        return buffers[bufferN];
    }

    function getBufferViewData (bufferView) {
        const data = getBufferData(bufferView.buffer);
        const byteOffset = _.get(bufferView, 'byteOffset', 0);
        const byteLength = _.get(bufferView, 'byteLength');

        return data.slice(byteOffset, byteOffset + byteLength);
    }

    function loadBufferView (gl, bufferView, target) {
        const data = getBufferViewData(bufferView);
        if (bufferView.target) {
            target = bufferView.target;
        }

        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, data, gl.STATIC_DRAW);

        return { target, buffer };
    }

    function bindBufferView (gl, bufferViews, bufferViewN) {
        const { target, buffer } = bufferViews[bufferViewN];
        gl.bindBuffer(target, buffer);
    }

    function bindTextureAs (gl, shader, name, materialRef, uniform, unit) {
        const index = _.get(materialRef, [ name, 'index' ]);

        const textureSpec = gltf.textures[index];
        const sampler = textureSpec.sampler ? gltf.samplers[textureSpec.sampler] : { };
        const texture = textures[textureSpec.source];

        logOnce('sampler', sampler, unit);

        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, _.get(sampler, 'magFilter', gl.LINEAR));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, _.get(sampler, 'minFilter', gl.LINEAR));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, _.get(sampler, 'wrapS', gl.REPEAT));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, _.get(sampler, 'wrapT', gl.REPEAT));

        shader.uniform1i(uniform, unit);
    }

    function setupShaderForMaterialTextured (gl, material, definesMap) {
        const pbrMetallicRoughness = material.pbrMetallicRoughness;

        // TODO DamagedHelmet seems to have sRGB albedo and emissive textures.

        if (false) {
            definesMap.HAVE_ALBEDO_SRGB = 1;
            definesMap.HAVE_EMISSIVE_SRGB = 1;
            definesMap.HAVE_IBL_SRGB = 1;

            definesMap.GAMME_CORRECT = 1;
            definesMap.HDR_TONEMAP = 1;
        }

        definesMap.HAVE_LIGHTS = conf.lights;
        definesMap.HAVE_IBL = conf.useIBL ? 1 : 0;
        definesMap.HAVE_LOD = haveLodSupport ? 1 : 0;

        if (_.has(material, 'occlusionTexture')) {
            definesMap.HAVE_OCCLUSION_TEXTURE = 1;
        }

        if (_.has(material, 'emissiveTexture')) {
            definesMap.HAVE_EMISSIVE_TEXTURE = 1;
        }

        const shader = getShader(gl, 'textured', definesMap);

        // Setup shader
        shader.use();

        shader.uniform3fv('camPos', viewPos);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, irradianceTexture);
        shader.uniform1i('irradianceSampler', 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, radianceTexture);
        shader.uniform1i('radianceSampler', 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, brdfTexture);
        shader.uniform1i('brdfSampler', 2);

        let unit = 3;

        bindTextureAs(gl, shader, 'baseColorTexture', pbrMetallicRoughness, 'albedoSampler', unit++);
        bindTextureAs(gl, shader, 'metallicRoughnessTexture', pbrMetallicRoughness, 'metallicRoughnessSampler', unit++);


        if (_.has(material, 'occlusionTexture')) {
            bindTextureAs(gl, shader, 'occlusionTexture', material, 'occlusionSampler', unit++);
        }

        if (_.has(material, 'emissiveTexture')) {
            bindTextureAs(gl, shader, 'emissiveTexture', material, 'emissiveSampler', unit++);
        }

        for (let i = 0; i < conf.lights; i++) {
            const color = _.get(conf, `color${i}`);
            const position = lightPositions[i];

            shader.uniform3fv(`lightPositions[${i}]`, position);
            shader.uniform3fv(`lightColors[${i}]`, vec3.fromValues(color[0], color[1], color[2]));
        }

        return shader;
    }

    const setupShaderForMaterial = setupShaderForMaterialTextured;

    // TODO With webgl2 we can use VertexArrayObject and move load part from draw to load
    function createMesh (gl, mesh) {
        const bufferViews = { };
        const uploadBufferView = (bufferViewN, target) => {
            console.log('loading', bufferViewN);
            if (!_.has(bufferViews, bufferViewN)) {
                const bufferView = gltf.bufferViews[bufferViewN];
                _.set(bufferViews, bufferViewN, loadBufferView(gl, bufferView, target));
            }
        };

        _.forEach(mesh.primitives, primitive => {
            const mode = _.get(primitive, 'mode', 4);

            if (mode != 4) {
                throw 'TODO X support primitive of other modes than 4';
            }

            // PREPARE
            // TODO This step could be moved to init and into a Vertex Array Object
            _.forEach(primitive.attributes, (accessorN, attribute) => {
                const accessor = gltf.accessors[accessorN]; // TODO prepare and link properly in gltf instead?

                if (_.has(attributeLocations, attribute)) {
                    if (_.has(accessor, 'sparse')) {
                        throw 'TODO X support accessors with sparse';
                    }

                    if (!_.has(accessor, 'bufferView')) {
                        throw 'TODO X support accessors without bufferView';
                    }

                    uploadBufferView(accessor.bufferView, gl.ARRAY_BUFFER);
                } else {
                    logOnce('WARN skipping', attribute);
                }
            });

            if (_.has(primitive, 'indices')) {
                const accessor = gltf.accessors[primitive.indices];
                uploadBufferView(accessor.bufferView, gl.ELEMENT_ARRAY_BUFFER);
            }
        });

        console.log('loaded', bufferViews);

        return {
            draw: function (projection, view, model) {
                _.forEach(mesh.primitives, primitive => {
                    logOnce('primitive', primitive);
                    const definesMap = { };

                    const mode = _.get(primitive, 'mode', 4);

                    if (mode != 4) {
                        throw 'TODO X support primitive of other modes than 4';
                    }

                    // PREPARE
                    // TODO This step could be moved to init and into a Vertex Array Object
                    _.forEach(primitive.attributes, (accessorN, attribute) => {
                        const accessor = gltf.accessors[accessorN]; // TODO prepare and link properly in gltf instead?

                        if (_.has(attributeLocations, attribute)) {
                            const location = attributeLocations[attribute];
                            _.set(definesMap, `HAVE_${attribute}`, 1);

                            const bufferView = gltf.bufferViews[accessor.bufferView];
                            bindBufferView(gl, bufferViews, accessor.bufferView);

                            const size = accessorType2size(accessor.type);
                            const componentType = _.get(accessor, 'componentType');
                            const normalized = _.get(accessor, 'normalized', false);
                            const byteStride = _.get(bufferView, 'byteStride', 0);
                            const byteOffset = _.get(accessor, 'byteOffset', 0);

                            gl.vertexAttribPointer(location, size, componentType, normalized, byteStride, byteOffset);
                            gl.enableVertexAttribArray(location);
                        } else {
                            logOnce('WARN skipping', attribute);
                        }
                    });

                    if (_.has(primitive, 'indices')) {
                        const accessor = gltf.accessors[primitive.indices];
                        bindBufferView(gl, bufferViews, accessor.bufferView);
                    }

                    // DRAW
                    const material = _.get(gltf.materials, primitive.material);
                    const shader = setupShaderForMaterial(gl, material, definesMap);

                    shader.uniformMatrix4fv('projection', projection);
                    shader.uniformMatrix4fv('view', view);
                    shader.uniformMatrix4fv('model', model);

                    if (_.has(primitive, 'indices')) {
                        const accessor = gltf.accessors[primitive.indices];
                        gl.drawElements(gl.TRIANGLES, accessor.count, accessor.componentType, null);
                    } else {
                        const accessor = gltf.accessors[primitive.attributes.POSITION];
                        gl.drawArrays(gl.TRIANGLES, 0, accessor.count);
                    }

                    // UNLOAD/UNBIND
                    // TODO Unnecessary if we had Vertex Array Objects?
                    _.forEach(primitive.attributes, (accessorN, attribute) => {
                        if (_.has(attributeLocations, attribute)) {
                            const location = attributeLocations[attribute];
                            gl.disableVertexAttribArray(location);
                        }
                    });
                });
            }
        };
    }

    function createImageTexture (gl, image) {
        console.log('creatingTexture', image, image.width, image.height);
        const texture = gl.createTexture();

        gl.bindTexture(gl.TEXTURE_2D, texture);
        //gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

        gl.bindTexture(gl.TEXTURE_2D, null);

        return texture;
    }

    function renderNode (gl, node, projection, view, model) {
        if (_.has(node, 'translation')) {
            model = mat4.multiply(mat4.create(), model, mat4.fromTranslation(mat4.create(), node.translation));
        }

        if (_.has(node, 'rotation')) {
            model = mat4.multiply(mat4.create(), model, mat4.fromQuat(mat4.create(), node.rotation));
        }

        if (_.has(node, 'scale')) {
            model = mat4.multiply(mat4.create(), model, mat4.fromScaling(mat4.create(), node.scale));
        }

        if (_.has(node, 'matrix')) {
            model = mat4.multiply(mat4.create(), model, new Float32Array(node.matrix));
        }

        if (_.has(node, 'camera')) {
            projection = cameras[node.camera];
        }

        if (_.has(node, 'mesh')) {
            const mesh = meshes[node.mesh];
            mesh.draw(projection, view, model);
        }

        if (_.has(node, 'children')) {
            _.forEach(node.children, child => {
                const node = gltf.nodes[child];
                renderNode(gl, node, projection, view, model);
            });
        }
    }

    const viewPos = vec3.fromValues(0.0, 0.0, -5.0);

    function renderScene (gl, scene) {
        const projection = mat4.perspective(mat4.create(), radians(45), viewport.width / viewport.height, 0.1, 800);
        const view = mat4.lookAt(mat4.create(), viewPos, [ 0, 0, 0], [ 0, 1, 0 ]);
        const model = mat4.fromRotation(mat4.create(), radians(20 * getTimeS()), vec3.fromValues(0.0, 1.0, 0.0));

        _.forEach(scene.nodes, nodeN => renderNode(gl, gltf.nodes[nodeN], projection, view, model));
    }

    const shaders = { };
    const createShader = (gl, name, defines) => {
        let { vs, fs } = ShaderLoader.load(name);
        vs = defines + '\n' + vs;
        fs = defines + '\n' + fs;

        const shader = new Shader(gl, vs, fs, attributeLocations);

        return shader;
    };

    const getShader = (gl, name, definesMap) => {
        const defines = _.map(_.filter(_.toPairs(definesMap), '[1]'), ([ key, value]) => `#define ${key} ${value}`).sort().join('\n');
        const path = `${name} ${defines}`;

        if (!_.has(shaders, path)) {
            _.set(shaders, path, createShader(gl, name, defines));
        }

        return _.get(shaders, path);
    };

    const loadCubemap = (gl, displayName, paths) => {
        return Promise.all(_.map(paths, path => ImageLoader.load(path)))
            .then(images => {
                const texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_CUBE_MAP, texture);
                const levels = images.length / 6;

                for (let i = 0; i < 6; i++) {
                    for (let level = 0; level < levels; level++) {
                        const index = level + levels * i;
                        const image = images[index];

                        gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, level, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
                    }
                }

                // gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
                // gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                // gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                // linear interpolation in srgb color space .. just great :(
                /*
                gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                */
                gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                gl.generateMipmap(gl.TEXTURE_CUBE_MAP);

                if (displayName) {
                    texture.displayName = displayName;
                }

                gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
                return texture;
            });
    };

    const loadBRDF = gl => {
        return ImageLoader.load(require('../resources/brdfLUT.png')).then(image => {
            brdfTexture = createImageTexture(gl, image);
        });
    };

    const loadCubemaps = gl => {
        return Promise.all([
            loadCubemap(gl, 'irradiance', [
                require('../resources/okretnica/irradiance_posx.png'),
                require('../resources/okretnica/irradiance_negx.png'),
                require('../resources/okretnica/irradiance_posy.png'),
                require('../resources/okretnica/irradiance_negy.png'),
                require('../resources/okretnica/irradiance_posz.png'),
                require('../resources/okretnica/irradiance_negz.png')
            ]),

            loadCubemap(gl, 'radiance', [
                require('../resources/okretnica/radiance_posx_0_256x256.png'),
                require('../resources/okretnica/radiance_posx_1_128x128.png'),
                require('../resources/okretnica/radiance_posx_2_64x64.png'),
                require('../resources/okretnica/radiance_posx_3_32x32.png'),
                require('../resources/okretnica/radiance_posx_4_16x16.png'),
                require('../resources/okretnica/radiance_posx_5_8x8.png'),
                require('../resources/okretnica/radiance_posx_6_4x4.png'),
                require('../resources/okretnica/radiance_posx_7_2x2.png'),
                require('../resources/okretnica/radiance_posx_8_1x1.png'),

                require('../resources/okretnica/radiance_negx_0_256x256.png'),
                require('../resources/okretnica/radiance_negx_1_128x128.png'),
                require('../resources/okretnica/radiance_negx_2_64x64.png'),
                require('../resources/okretnica/radiance_negx_3_32x32.png'),
                require('../resources/okretnica/radiance_negx_4_16x16.png'),
                require('../resources/okretnica/radiance_negx_5_8x8.png'),
                require('../resources/okretnica/radiance_negx_6_4x4.png'),
                require('../resources/okretnica/radiance_negx_7_2x2.png'),
                require('../resources/okretnica/radiance_negx_8_1x1.png'),

                require('../resources/okretnica/radiance_posy_0_256x256.png'),
                require('../resources/okretnica/radiance_posy_1_128x128.png'),
                require('../resources/okretnica/radiance_posy_2_64x64.png'),
                require('../resources/okretnica/radiance_posy_3_32x32.png'),
                require('../resources/okretnica/radiance_posy_4_16x16.png'),
                require('../resources/okretnica/radiance_posy_5_8x8.png'),
                require('../resources/okretnica/radiance_posy_6_4x4.png'),
                require('../resources/okretnica/radiance_posy_7_2x2.png'),
                require('../resources/okretnica/radiance_posy_8_1x1.png'),

                require('../resources/okretnica/radiance_negy_0_256x256.png'),
                require('../resources/okretnica/radiance_negy_1_128x128.png'),
                require('../resources/okretnica/radiance_negy_2_64x64.png'),
                require('../resources/okretnica/radiance_negy_3_32x32.png'),
                require('../resources/okretnica/radiance_negy_4_16x16.png'),
                require('../resources/okretnica/radiance_negy_5_8x8.png'),
                require('../resources/okretnica/radiance_negy_6_4x4.png'),
                require('../resources/okretnica/radiance_negy_7_2x2.png'),
                require('../resources/okretnica/radiance_negy_8_1x1.png'),

                require('../resources/okretnica/radiance_posz_0_256x256.png'),
                require('../resources/okretnica/radiance_posz_1_128x128.png'),
                require('../resources/okretnica/radiance_posz_2_64x64.png'),
                require('../resources/okretnica/radiance_posz_3_32x32.png'),
                require('../resources/okretnica/radiance_posz_4_16x16.png'),
                require('../resources/okretnica/radiance_posz_5_8x8.png'),
                require('../resources/okretnica/radiance_posz_6_4x4.png'),
                require('../resources/okretnica/radiance_posz_7_2x2.png'),
                require('../resources/okretnica/radiance_posz_8_1x1.png'),

                require('../resources/okretnica/radiance_negz_0_256x256.png'),
                require('../resources/okretnica/radiance_negz_1_128x128.png'),
                require('../resources/okretnica/radiance_negz_2_64x64.png'),
                require('../resources/okretnica/radiance_negz_3_32x32.png'),
                require('../resources/okretnica/radiance_negz_4_16x16.png'),
                require('../resources/okretnica/radiance_negz_5_8x8.png'),
                require('../resources/okretnica/radiance_negz_6_4x4.png'),
                require('../resources/okretnica/radiance_negz_7_2x2.png'),
                require('../resources/okretnica/radiance_negz_8_1x1.png')
            ]),
        ])
            .then(res => {
                irradianceTexture = res[0];
                radianceTexture = res[1];
            });
    };

    const load = gl => {
        haveLodSupport = !!gl.getExtension('EXT_shader_texture_lod');
        haveFloatSupport = !!gl.getExtension('OES_texture_float') && !!gl.getExtension('OES_texture_float_linear');

        console.log('haveLodSupport', haveLodSupport);
        console.log('haveFloatSupport', haveFloatSupport);

        return Promise.all([
            GLTF2Loader.load('DamagedHelmet').then(res => {
                gltf = res.gltf;
                buffers = res.buffers;
                images = res.images;

                meshes = _.map(gltf.meshes, mesh => createMesh(gl, mesh));

                textures = _.map(images, image => createImageTexture(gl, image));
            }),
            loadCubemaps(gl),
            loadBRDF(gl)
        ]);
    };

    let viewport = { width: 640, height: 480 };
    const init = (gl, width, height) => {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        //gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.DEPTH_TEST);
        //gl.enable(gl.TEXTURE_2D);
        gl.disable(gl.BLEND);

        gl.viewport(0, 0, width, height);

        viewport = { width, height };
    };

    const render = (gl) => {
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const sceneN = gltf.scene || 0; // TODO if no default scene, skip render?
        renderScene(gl, gltf.scenes[sceneN]);

        first = false;
    };

    return { load, init, render };
};

module.exports = create;
