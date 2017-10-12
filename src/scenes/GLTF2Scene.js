'use strict';

const { vec2, vec3, vec4, quat, mat2, mat3, mat4 } = require('gl-matrix');
const _ = require('lodash');

const Shader = require('../Shader');
const GLTF2Loader = require('../GLTF2Loader');
const ShaderLoader = require('../ShaderLoader');
const ImageLoader = require('../ImageLoader');

const getCurTimeMS = () => (new Date()).getTime();
const getCurTimeS = () => getTimeMS() / 1000;

const initialMS = getCurTimeMS();
const getTimeMS = () => getCurTimeMS() - initialMS;
const getTimeS = () => getTimeMS() / 1000;

const radians = degrees => degrees * Math.PI / 180;
const degrees = radians => radians * 180 / Math.PI;

const DEBUG_ACCESSOR = false;
const DEBUG_SHADERS = true;
const DEBUG_MATERIAL = false;

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
}

const typeArray = (componentType) => {
    if (componentType == gl.FLOAT) {
        return Float32Array;
    } else if (componentType == gl.UNSIGNED_INT) {
        return Uint32Array;
    } else if (componentType == gl.UNSIGNED_SHORT) {
        return Uint16Array;
    } else if (componentType == gl.UNSIGNED_BYTE) {
        return Uint8Array;
    }
};

const accessorType2size = type => accessorTypeSizes[type];

const create = () => {

    /* GLTFS stuff */
    let gltf;
    let buffers;
    let images;

    let texture;

    let meshes = [];
    let cameras = [];
    let textures = [];

    /*  Pipeline stuff */
    let fsQuad;
    let skyboxTexture;
    let irradianceTexture;
    let radianceTexture;
    let brdfTexture;

    let haveLodSupport = false;
    let haveFloatSupport = false;

    function loadQuad(gl) {
        const vertices = new Float32Array([
        //   x   y  z  u  v
            -1, -1, 0, 0, 0,
             1, -1, 0, 1, 0,
             1,  1, 0, 1, 1,
            -1,  1, 0, 0, 1
        ]);

        const indices = new Uint8Array([
            0, 1, 2,
            0, 2, 3
        ]);

        const arrayBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

        const elementArrayBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementArrayBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

        return {
            draw: () => {
                gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
                gl.vertexAttribPointer(attributeLocations.POSITION, 3, gl.FLOAT, false, 5 * Float32Array.BYTES_PER_ELEMENT, 0);
                gl.enableVertexAttribArray(attributeLocations.POSITION);

                gl.vertexAttribPointer(attributeLocations.TEXCOORD_0, 2, gl.FLOAT, false, 5 * Float32Array.BYTES_PER_ELEMENT, 3 * Float32Array.BYTES_PER_ELEMENT);
                gl.enableVertexAttribArray(attributeLocations.TEXCOORD_0);

                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementArrayBuffer);
                gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, null);
            }
        };
    };

    function prepareData(data, offset, length, Type) {
        data = data.slice(offset, offset + length);

        if (Type) {
            data = new Type(data.buffer);
        }

        return data;
    }

    function getBufferData(bufferN) {
        return buffers[bufferN];
    }

    function getBufferViewData(bufferView) {
        const data = getBufferData(bufferView.buffer);
        const byteOffset = _.get(bufferView, 'byteOffset', 0);
        const byteLength = _.get(bufferView, 'byteLength');

        return data.slice(byteOffset, byteOffset + byteLength);
    }

    function loadBufferView(gl, bufferView, target) {
        const data = getBufferViewData(bufferView);
        if (bufferView.target) {
            target = bufferView.target;
        }

        const buffer = gl.createBuffer();
        gl.bindBuffer(target, buffer);
        gl.bufferData(target, data, gl.STATIC_DRAW);

        return { target, buffer };
    }

    function bindBufferView(gl, bufferViews, bufferViewN) {
        const { target, buffer } = bufferViews[bufferViewN];
        gl.bindBuffer(target, buffer);
    }

    function loadCamera(camera) {
        if (camera.type == 'perspective') {
            const perspective = camera.perspective;

            if (!_.has(perspective, 'zfar')) {
                throw 'TODO X camera support infinite zfar';
            }

            const yfov = _.get(perspective, 'yfov');
            const aspectRatio = _.get(perspective, 'aspectRatio');
            const znear = _.get(perspective, 'znear');
            const zfar = _.get(perspective, 'zfar');

            return mat4.perspective(mat4.create(), yfov, aspectRatio, znear, zfar);
        } else if (camera.type == 'orthographic') {
            throw 'TODO X camera support orthographic';

            const orthographic = camera.orthographic;

            const xmag = _.get(orthographic, 'xmag');
            const ymag = _.get(orthographic, 'ymag');
            const znear = _.get(orthographic, 'znear');
            const zfar = _.get(orthographic, 'zfar');

            // Is this correct?
            return mat4.ortho(mat4.create(), -xmag / 2, xmag / 2, -ymag / 2, ymag / 2);
        }
    }

    function bindTexture(gl, shader, name, materialRef, unit) {
        bindTextureAs(gl, shader, name + 'Texture', materialRef, name + 'Sampler', unit);
    }

    function bindTextureAs(gl, shader, name, materialRef, uniform, unit) {
        const index = _.get(materialRef, [ name, 'index' ]);

        const textureSpec = gltf.textures[index];
        const sampler = textureSpec.sampler ? gltf.samplers[textureSpec.sampler] : { };
        const texture = textures[textureSpec.source];

        logOnce('sampler', sampler, unit)

        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, _.get(sampler, 'magFilter', gl.LINEAR));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, _.get(sampler, 'minFilter', gl.LINEAR));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, _.get(sampler, 'wrapS', gl.REPEAT));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, _.get(sampler, 'wrapT', gl.REPEAT));

        shader.uniform1i(uniform, unit);
    }

    function setupShaderForMaterialTextured(gl, material, definesMap) {
        const pbrMetallicRoughness = material.pbrMetallicRoughness;

        // TODO DamagedHelmet seems to have sRGB albedo and emissive textures.

        if (false) {
            definesMap.HAVE_ALBEDO_SRGB = 1;
            definesMap.HAVE_EMISSIVE_SRGB = 1;
            definesMap.HAVE_IBL_SRGB = 1;

            definesMap.GAMME_CORRECT = 1;
            definesMap.HDR_TONEMAP = 1;
        }

        definesMap.HAVE_LIGHTS = lights.length;
        definesMap.HAVE_IBL = 1;
        definesMap.HAVE_LOD = haveLodSupport ? 1 : 0;
        //definesMap.MAX_REFLECTION_LOD = 4.0;


        if (_.has(material, 'occlusionTexture')) {
            definesMap.HAVE_OCCLUSION_TEXTURE = 1;
        }

        if (_.has(material, 'emissiveTexture')) {
            definesMap.HAVE_EMISSIVE_TEXTURE = 1;
        }

        const shader = getShader(gl, 'textured', definesMap);

        // Setup shader
        shader.use();

        // Remove later
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

        _.forEach(lights, (light, i) => {
            shader.uniform3fv(`lightPositions[${i}]`, light.position);
            shader.uniform3fv(`lightColors[${i}]`, light.color);
        });

        return shader;
    }

    const setupShaderForMaterial = setupShaderForMaterialTextured;

    // TODO With webgl2 we can use VertexArrayObject and move load part from draw to load
    function createMesh(gl, mesh) {
        const debugAccessor = (name, accessor) => {
            //console.log('asked', name);

            if (DEBUG_ACCESSOR && first) {
                const bufferView = gltf.bufferViews[accessor.bufferView];

                const size = accessorType2size(accessor.type);
                const componentType = _.get(accessor, 'componentType');
                const normalized = _.get(accessor, 'normalized', false);
                const byteStride = _.get(bufferView, 'byteStride', 0);
                const byteOffset = _.get(accessor, 'byteOffset', 0);
                const count = _.get(accessor, 'count');

                const bvData = getBufferViewData(bufferView);
                const Type = typeArray(componentType);
                const aData = prepareData(bvData, byteOffset, count * size * Type.BYTES_PER_ELEMENT, Type)
                logOnce('accesor', name, aData);
            }
        };

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
                const accessor = gltf.accessors[primitive.indices]
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

                            gl.vertexAttribPointer(location, size, componentType, normalized, byteStride, byteOffset)
                            gl.enableVertexAttribArray(location);
                        } else {
                            logOnce('WARN skipping', attribute);
                        }
                    });

                    if (_.has(primitive, 'indices')) {
                        const accessor = gltf.accessors[primitive.indices]
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
                        const accessor = gltf.accessors[accessorN]; // TODO prepare and link properly in gltf instead?

                        if (_.has(attributeLocations, attribute)) {
                            const location = attributeLocations[attribute];
                            gl.disableVertexAttribArray(location);
                        }
                    });
                })
            }
        }
    }

    function createImageTexture(gl, image) {
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

    function renderNode(gl, node, projection, view, model) {
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

    //const viewPos = vec3.fromValues(0, 0.05, -0.15);
    const viewPos = vec3.fromValues(0.0, 0.0, -5.0);

    const lights = [
        {
            position: vec3.fromValues(0, 5, 0),
            color: vec3.fromValues(300, 300, 300)
        }
    ];

    function renderScene(gl, scene) {
        const projection = mat4.perspective(mat4.create(), radians(45), viewport.width / viewport.height, 0.1, 800);
        const view = mat4.lookAt(mat4.create(), viewPos, [ 0, 0, 0], [ 0, 1, 0 ]);
        //const model = mat4.fromRotation(mat4.create(), radians(20 * getTimeS()), vec3.fromValues(1.0, 0.3, 0.5));
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

                for (var i = 0; i < 6; i++) {
                    for (var level = 0; level < levels; level++) {
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
                loadCubemap(gl, 'skybox', [
                    require('../resources/okretnica/skybox_posx.png'),
                    require('../resources/okretnica/skybox_negx.png'),
                    require('../resources/okretnica/skybox_posy.png'),
                    require('../resources/okretnica/skybox_negy.png'),
                    require('../resources/okretnica/skybox_posz.png'),
                    require('../resources/okretnica/skybox_negz.png')
                ]),

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
                skyboxTexture = res[0];
                irradianceTexture = res[1];
                radianceTexture = res[2];
            });
    };

    const load = (gl, width, height) => {
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
                cameras = _.map(gltf.cameras, loadCamera);

                textures = _.map(images, image => createImageTexture(gl, image));

                fsQuad = loadQuad(gl);
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

        if (DEBUG_MATERIAL) {
            const projection = mat4.ortho(mat4.create(), -1, 1, -1, 1, -1, 1);
            const view = mat4.create();
            const model = mat4.create();

            const shader = setupShaderForMaterial(gl, gltf.materials[0], { HAVE_POSITION: 1, HAVE_TEXCOORD_0: 1 });

            shader.uniformMatrix4fv('projection', projection);
            shader.uniformMatrix4fv('view', view);
            shader.uniformMatrix4fv('model', model);

            fsQuad.draw();
        } else {
            const sceneN = gltf.scene || 0; // TODO if no default scene, skip render?
            renderScene(gl, gltf.scenes[sceneN])
        }

        first = false;
    };

    return { load, init, render };
};

module.exports = create;
