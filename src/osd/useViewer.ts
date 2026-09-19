/** OpenSeadragon 实例的生命周期与加载/模式控制。 */
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import OpenSeadragon from 'openseadragon'

import type { PreparedImage, ToolMode } from '../types'

export function useViewer(getContainer: () => HTMLElement | null) {
  const viewer = shallowRef<OpenSeadragon.Viewer | null>(null)
  /** 图像已就绪。叠加层要等它为 true 才有意义。 */
  const isOpen = ref(false)
  const failure = ref<string | null>(null)

  function init() {
    const element = getContainer()
    if (!element || viewer.value) return

    const instance = OpenSeadragon({
      element,
      // 自带按钮需要 prefixUrl 指向图片资源,还要把资源拷进 public/。
      // 关掉它,用自己画的工具栏,少一处静态资源依赖。
      showNavigationControl: false,
      // 小地图对超大图定位很有用,保留
      showNavigator: true,
      navigatorPosition: 'BOTTOM_RIGHT',
      navigatorSizeRatio: 0.15,
      navigatorBorderColor: '#444',
      animationTime: 0.4,
      zoomPerScroll: 1.4,
      // 允许放大到 1:1 的 8 倍以便看清单个像素;
      // 缩到最小 0.02 倍,超大图也能一眼看全
      maxZoomPixelRatio: 8,
      minZoomImageRatio: 0.02,
      visibilityRatio: 0.5,
      constrainDuringPan: true,
      // OSD 默认缓存 200 张瓦片,而且**不按内存预算**。512 瓦片是 1MB/张,
      // 但 1024 瓦片解码后是 4MB/张 —— 默认值会吃掉 800MB。
      // 平铺 1080p 视口、1024 瓦片时实际只需要约 9 张,加倍留余量足够。
      maxImageCacheCount: 80,
      // 我们的瓦片来自自定义协议,不是跨域资源,不需要 CORS 协商
      crossOriginPolicy: false,
      // canvas drawer 用 <img> 加载瓦片。别换成 webgl drawer —— 它走 XHR,
      // 会撞上 range 请求相关的坑,而这个项目完全不需要 WebGL。
      drawer: 'canvas',
      gestureSettingsMouse: {
        dragToPan: true,
        scrollToZoom: true,
        // 关掉点击缩放,否则会和「拖拽画框」抢事件
        clickToZoom: false,
        dblClickToZoom: false,
        flickEnabled: false,
        pinchToZoom: false,
      },
      gestureSettingsTouch: {
        // 触控板/触摸屏上保留双指缩放,但不要点击缩放
        clickToZoom: false,
        dblClickToZoom: false,
      },
    })

    instance.addHandler('open', () => {
      isOpen.value = true
      failure.value = null
    })
    instance.addHandler('open-failed', (event) => {
      isOpen.value = false
      failure.value = String(event.message ?? '图像加载失败')
    })

    viewer.value = instance
  }

  /**
   * 加载已切片的图像。
   *
   * 直接用元数据构造 DziTileSource,**不走 `tileSources: 'xxx.dzi'` 字符串路径**。
   * 好处:不产生 .dzi 的 XHR(少一次往返、少一条 CSP 规则)、绕开相对路径解析、
   * 而且 tilesUrl 是我们算好的绝对地址。秒开体验也更好。
   */
  function load(image: PreparedImage) {
    const instance = viewer.value
    if (!instance) return

    isOpen.value = false
    instance.open({
      tileSource: new OpenSeadragon.DziTileSource({
        width: image.width,
        height: image.height,
        tileSize: image.tileSize,
        tileOverlap: image.tileOverlap,
        tilesUrl: image.tilesUrl,
        fileFormat: image.fileFormat,
      }),
    })
  }

  /**
   * 切换工具模式。
   *
   * **不能用 `setMouseNavEnabled(false)`** —— 它内部是 `innerTracker.setTracking(false)`,
   * 会把滚轮缩放一起禁掉,用户就完全没法缩放图像了。
   * `dragToPan` 才是正确开关:OSD 在每个指针事件里实时读取它,
   * 改完立即生效,且滚轮缩放不受影响。
   */
  function setMode(mode: ToolMode) {
    const instance = viewer.value
    if (!instance) return

    instance.gestureSettingsByDeviceType('mouse').dragToPan = mode === 'pan'
    instance.element.style.cursor = mode === 'pan' ? 'grab' : 'crosshair'
  }

  function destroy() {
    viewer.value?.destroy()
    viewer.value = null
  }

  onBeforeUnmount(destroy)

  return { viewer, isOpen, failure, init, load, setMode, destroy }
}
