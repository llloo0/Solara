/* global self */
(function () {
    if (typeof self.solaraMd5 !== "function") {
        importScripts("/js/ibroadcast-md5.js");
    }

    self.onmessage = (event) => {
        try {
            if (typeof self.solaraMd5 !== "function") {
                throw new Error("MD5 计算模块未加载");
            }
            self.postMessage({ md5: self.solaraMd5(new Uint8Array(event.data.bytes)) });
        } catch (error) {
            self.postMessage({ error: error instanceof Error ? error.message : "音频 MD5 计算失败" });
        }
    };
})();
