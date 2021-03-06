/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
import Browser from '../utils/browser.js';
import {BaseLoader, LoaderStatus, LoaderErrors} from './loader.js';
import {RuntimeException} from '../utils/exception.js';

/* fetch + stream IO loader. Currently working on chrome 43+.
 * fetch provides a better alternative http API to XMLHttpRequest
 *
 * fetch spec   https://fetch.spec.whatwg.org/
 * stream spec  https://streams.spec.whatwg.org/
 */
class FetchStreamLoader extends BaseLoader {

    static isSupported() {
        try {
            // fetch + stream is broken on Microsoft Edge. Disable before build 15048.
            // see https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/8196907/
            // Fixed in Jan 10, 2017. Build 15048+ removed from blacklist.
            let isWorkWellEdge = Browser.msedge && Browser.version.minor >= 15048;
            let browserNotBlacklisted = Browser.msedge ? isWorkWellEdge : true;
            return (self.fetch && self.ReadableStream && browserNotBlacklisted);
        } catch (e) {
            return false;
        }
    }

    constructor(seekHandler, config) {
        super('fetch-stream-loader');
        this.TAG = 'FetchStreamLoader';

        this._seekHandler = seekHandler;
        this._config = config;
        this._needStash = true;

        this._requestAbort = false;
        this._contentLength = null;
        this._receivedLength = 0;
    }

    destroy() {
        if (this.isWorking()) {
            this.abort();
        }
        super.destroy();
    }
    /*
        dataSource => {
            cors: true
            duration: undefined
            filesize: undefined
            timestampBase: 0
            url: "https://6721.liveplay.now.qq.com/live/6721_5abbc4bfd21679e67d3e131e1a3b81dc.flv?txSecret=59af3a6f7e13d4d064823d955603ef5c&txTime=5CD15A5E"
            withCredentials: false
        }
        range => {
            from: 0
            to: -1
        }
    */
    open(dataSource, range) {
        this._dataSource = dataSource;
        this._range = range;

        let sourceURL = dataSource.url;
        if (this._config.reuseRedirectedURL && dataSource.redirectedURL != undefined) { // 判断为false
            sourceURL = dataSource.redirectedURL;
        }

        // {
        //     "url": "https://6721.liveplay.now.qq.com/live/6721_5abbc4bfd21679e67d3e131e1a3b81dc.flv?txSecret=cbfb83bee99c88415c86090f6a9c49fb&txTime=5CD1658C",
        //     "headers": {}
        // }
        let seekConfig = this._seekHandler.getConfig(sourceURL, range);

        // {}
        let headers = new self.Headers();

        // 整段可以跳过
        if (typeof seekConfig.headers === 'object') {
            let configHeaders = seekConfig.headers;
            for (let key in configHeaders) {
                if (configHeaders.hasOwnProperty(key)) {
                    headers.append(key, configHeaders[key]);
                }
            }
        }

        let params = {
            method: 'GET',
            headers: headers,
            mode: 'cors',
            cache: 'default',
            // The default policy of Fetch API in the whatwg standard
            // Safari incorrectly indicates 'no-referrer' as default policy, fuck it
            referrerPolicy: 'no-referrer-when-downgrade'
        };

        // 整段可以跳过
        // add additional headers
        if (typeof this._config.headers === 'object') {
            for (let key in this._config.headers) {
                headers.append(key, this._config.headers[key]);
            }
        }

        // dataSource.cors => true
        // cors is enabled by default
        if (dataSource.cors === false) {
            // no-cors means 'disregard cors policy', which can only be used in ServiceWorker
            params.mode = 'same-origin';
        }

        // dataSource.withCredentials => false
        // withCredentials is disabled by default
        if (dataSource.withCredentials) {
            params.credentials = 'include';
        }

        // dataSource.referrerPolicy => undefined
        // referrerPolicy from config
        if (dataSource.referrerPolicy) {
            params.referrerPolicy = dataSource.referrerPolicy;
        }

        this._status = LoaderStatus.kConnecting;
        // params => {
        //     "method": "GET",
        //     "headers": {},
        //     "mode": "cors",
        //     "cache": "default",
        //     "referrerPolicy": "no-referrer-when-downgrade"
        // }
        self.fetch(seekConfig.url, params).then((res) => {
            // 跳过
            if (this._requestAbort) {
                this._requestAbort = false;
                this._status = LoaderStatus.kIdle;
                return;
            }

            // res =>
            //  body: ReadableStream
            //  bodyUsed: false
            //  headers: Headers {}
            //  ok: true
            //  redirected: false
            //  status: 200
            //  statusText: "OK"
            //  type: "cors"
            //  url: "https://6721.liveplay.now.qq.com/live/6721_5abbc4bfd21679e67d3e131e1a3b81dc.flv?txSecret=59af3a6f7e13d4d064823d955603ef5c&txTime=5CD15A5E"
            if (res.ok && (res.status >= 200 && res.status <= 299)) { // 判断为true
                // false，跳过
                if (res.url !== seekConfig.url) {
                    if (this._onURLRedirect) {
                        let redirectedURL = this._seekHandler.removeURLParameters(res.url);
                        this._onURLRedirect(redirectedURL);
                    }
                }

                // 直播时，lengthHeader为null
                let lengthHeader = res.headers.get('Content-Length'); 
                // 跳过
                if (lengthHeader != null) {
                    this._contentLength = parseInt(lengthHeader);
                    if (this._contentLength !== 0) {
                        if (this._onContentLengthKnown) {
                            this._onContentLengthKnown(this._contentLength);
                        }
                    }
                }

                return this._pump.call(this, res.body.getReader());
            } else {
                this._status = LoaderStatus.kError;
                if (this._onError) {
                    this._onError(LoaderErrors.HTTP_STATUS_CODE_INVALID, {code: res.status, msg: res.statusText});
                } else {
                    throw new RuntimeException('FetchStreamLoader: Http code invalid, ' + res.status + ' ' + res.statusText);
                }
            }
        }).catch((e) => {
            this._status = LoaderStatus.kError;
            if (this._onError) {
                this._onError(LoaderErrors.EXCEPTION, {code: -1, msg: e.message});
            } else {
                throw e;
            }
        });
    }

    abort() {
        this._requestAbort = true;
    }

    /*
        reader => ReadableStreamDefaultReader
        参考：https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader
    */
    _pump(reader) {  // ReadableStreamReader
        return reader.read().then((result) => {
            // 直播中时，result.done 为false，这里先跳过
            if (result.done) {
                // First check received length
                if (this._contentLength !== null && this._receivedLength < this._contentLength) {
                    // Report Early-EOF
                    this._status = LoaderStatus.kError;
                    let type = LoaderErrors.EARLY_EOF;
                    let info = {code: -1, msg: 'Fetch stream meet Early-EOF'};
                    if (this._onError) {
                        this._onError(type, info);
                    } else {
                        throw new RuntimeException(info.msg);
                    }
                } else {
                    // OK. Download complete
                    this._status = LoaderStatus.kComplete;
                    if (this._onComplete) {
                        this._onComplete(this._range.from, this._range.from + this._receivedLength - 1);
                    }
                }
            } else { // 进入这个分支
                // this._requestAbort => false，跳过
                if (this._requestAbort === true) {
                    this._requestAbort = false;
                    this._status = LoaderStatus.kComplete;
                    return reader.cancel();
                }

                // 修改加载状态为 LoaderStatus.kBuffering 
                this._status = LoaderStatus.kBuffering;

                // result.value 为 Uint8Array 类型，即字节数组，比如 Uint8Array(524288)
                // result.value.buffer 返回实际的内存数据
                let chunk = result.value.buffer;
                
                // this._range.from 初始值为0
                // this._receivedLength 初始值为0，为总共收到的字节数（累加）
                let byteStart = this._range.from + this._receivedLength;
                
                // 将收到的字节数累加
                this._receivedLength += chunk.byteLength;

                // 对应 io-controller.js 中的 _onLoaderChunkArrival(chunk, byteStart, receivedLength)  方法
                if (this._onDataArrival) {
                    this._onDataArrival(chunk, byteStart, this._receivedLength);
                }

                this._pump(reader);
            }
        }).catch((e) => {
            if (e.code === 11 && Browser.msedge) {  // InvalidStateError on Microsoft Edge
                // Workaround: Edge may throw InvalidStateError after ReadableStreamReader.cancel() call
                // Ignore the unknown exception.
                // Related issue: https://developer.microsoft.com/en-us/microsoft-edge/platform/issues/11265202/
                return;
            }

            this._status = LoaderStatus.kError;
            let type = 0;
            let info = null;

            if ((e.code === 19 || e.message === 'network error') && // NETWORK_ERR
                (this._contentLength === null ||
                (this._contentLength !== null && this._receivedLength < this._contentLength))) {
                type = LoaderErrors.EARLY_EOF;
                info = {code: e.code, msg: 'Fetch stream meet Early-EOF'};
            } else {
                type = LoaderErrors.EXCEPTION;
                info = {code: e.code, msg: e.message};
            }

            if (this._onError) {
                this._onError(type, info);
            } else {
                throw new RuntimeException(info.msg);
            }
        });
    }

}

export default FetchStreamLoader;
