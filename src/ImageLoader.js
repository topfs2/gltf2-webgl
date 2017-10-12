const load = src => {
    const image = new Image();

    const promise = new Promise((resolve, reject) => {
        image.onload = () => resolve(image);
        image.onerror = () => reject(`Failed to load image ${src}`);
    });

    image.src = src;
    return promise;
};

module.exports = {
    load
};
