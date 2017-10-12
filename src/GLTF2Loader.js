const ImageLoader = require('./ImageLoader');

const DEBUG = true;

const load = name => {
    return Promise.resolve()
        .then(() => {
            if (DEBUG) {
                console.log('loading', name, `./resources/gltf2/${name}/glTF/${name}.gltf`);
            }
            const gltf = require(`./resources/gltf2/${name}/glTF/${name}.gltf`);

            const buffers = _.map(gltf.buffers, buffer => {
                if (!buffer.uri) {
                    throw 'TODO X Handle glb buffers';
                }

                if (!buffer.uri.endsWith('.bin')) {
                    throw 'TODO X Handle other extensions of binary than .bin';
                }

                const safeURI = buffer.uri.slice(0, -4);
                if (DEBUG) {
                    console.log('loading', buffer.uri, `./resources/gltf2/${name}/glTF/${safeURI}.bin`);
                }
                return new Uint8Array(require(`./resources/gltf2/${name}/glTF/${safeURI}.bin`));
            });

            const images = _.map(gltf.images, image => {
                if (!image.uri) {
                    throw 'TODO X Handle glb buffers';
                }

                if (image.uri.endsWith('.png') || image.uri.endsWith('.jpg')) {
                    const extension = image.uri.slice(-4);
                    const safeURI = image.uri.slice(0, -4);
                    if (DEBUG) {
                        console.log('loading', image.uri, `./resources/gltf2/${name}/glTF/${safeURI}.${extension}`);
                    }

                    // Cannot use extension string, since using it wouldn't trigger webpack loaders
                    const finalURI = image.uri.endsWith('.png') ? require(`./resources/gltf2/${name}/glTF/${safeURI}.png`) : require(`./resources/gltf2/${name}/glTF/${safeURI}.jpg`);
                    if (DEBUG) {
                        console.log('resolved as', finalURI);
                    }
                    return ImageLoader.load(finalURI);
                } else {
                    throw 'TODO X Handle other extensions of binary than .png or .jpg';
                }
            });

            return Promise.all(images).then((images) => {
                if (DEBUG) {
                    console.log('GLTF2 result', gltf, buffers, images);
                }

                return { gltf, buffers, images };
            });
        });
};

module.exports = {
    load
};
