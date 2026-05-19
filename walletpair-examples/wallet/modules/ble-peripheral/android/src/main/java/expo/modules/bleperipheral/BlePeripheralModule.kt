package expo.modules.bleperipheral

import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentLinkedQueue

class BlePeripheralModule : Module() {

  private var gattServer: BluetoothGattServer? = null
  private var advertiser: BluetoothLeAdvertiser? = null
  private var currentAdvCallback: AdvertiseCallback? = null
  private var connectedDevice: BluetoothDevice? = null
  private var notifyChar: BluetoothGattCharacteristic? = null
  private var negotiatedMtu: Int = 23 // BLE default
  private val sendQueue = ConcurrentLinkedQueue<ByteArray>()
  @Volatile private var draining = false

  private val CCC_DESCRIPTOR_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  private val TAG = "BlePeripheral"

  override fun definition() = ModuleDefinition {
    Name("BlePeripheral")

    Events("onWrite", "onSubscribe", "onUnsubscribe", "onConnect", "onDisconnect", "onMtuChanged")

    AsyncFunction("start") { svcUuid: String, writeUuid: String, notifyUuid: String, name: String ->
      val ctx = appContext.reactContext ?: throw Exception("No context")
      val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
      val adapter = manager.adapter ?: throw Exception("Bluetooth not available")

      stopInternal(adapter)

      val service = BluetoothGattService(
        UUID.fromString(svcUuid), BluetoothGattService.SERVICE_TYPE_PRIMARY)

      val writeCh = BluetoothGattCharacteristic(
        UUID.fromString(writeUuid),
        BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE)
      service.addCharacteristic(writeCh)

      val notifyCh = BluetoothGattCharacteristic(
        UUID.fromString(notifyUuid),
        BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ)
      val cccDesc = BluetoothGattDescriptor(
        CCC_DESCRIPTOR_UUID,
        BluetoothGattDescriptor.PERMISSION_WRITE or BluetoothGattDescriptor.PERMISSION_READ)
      notifyCh.addDescriptor(cccDesc)
      service.addCharacteristic(notifyCh)
      notifyChar = notifyCh

      gattServer = manager.openGattServer(ctx, gattCallback)
      gattServer?.addService(service)

      adapter.name = name

      val adv = adapter.bluetoothLeAdvertiser
        ?: throw Exception("BLE advertising not supported")
      advertiser = adv

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setConnectable(true).setTimeout(0).build()
      val data = AdvertiseData.Builder().setIncludeDeviceName(true).build()

      val latch = CountDownLatch(1)
      var advError: String? = null
      val callback = object : AdvertiseCallback() {
        override fun onStartSuccess(s: AdvertiseSettings?) { latch.countDown() }
        override fun onStartFailure(errorCode: Int) {
          advError = "Advertising failed: code $errorCode"
          latch.countDown()
        }
      }
      currentAdvCallback = callback
      adv.startAdvertising(settings, data, callback)

      if (!latch.await(5, TimeUnit.SECONDS)) throw Exception("Advertising timed out")
      if (advError != null) { stopInternal(adapter); throw Exception(advError!!) }
    }

    AsyncFunction("stop") {
      val ctx = appContext.reactContext
      if (ctx != null) {
        val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val adapter = manager.adapter
        if (adapter != null) stopInternal(adapter)
      }
    }

    // Send a single notification frame
    AsyncFunction("sendNotification") { base64Data: String ->
      val device = connectedDevice ?: return@AsyncFunction
      val ch = notifyChar ?: return@AsyncFunction
      val server = gattServer ?: return@AsyncFunction
      val bytes = Base64.decode(base64Data, Base64.NO_WRAP)
      ch.value = bytes
      server.notifyCharacteristicChanged(device, ch, false)
    }

    // Send all frames at once — avoids N round-trips through JS↔Native bridge
    AsyncFunction("sendBatch") { base64Frames: List<String> ->
      val device = connectedDevice ?: return@AsyncFunction
      val ch = notifyChar ?: return@AsyncFunction
      val server = gattServer ?: return@AsyncFunction

      for (b64 in base64Frames) {
        val bytes = Base64.decode(b64, Base64.NO_WRAP)
        ch.value = bytes
        server.notifyCharacteristicChanged(device, ch, false)
      }
    }
  }

  private fun stopInternal(adapter: BluetoothAdapter) {
    val cb = currentAdvCallback
    if (cb != null) {
      try { adapter.bluetoothLeAdvertiser?.stopAdvertising(cb) } catch (_: Exception) {}
      currentAdvCallback = null
    }
    try { gattServer?.close() } catch (_: Exception) {}
    gattServer = null; advertiser = null; connectedDevice = null; notifyChar = null
    negotiatedMtu = 23
    sendQueue.clear()
    Thread.sleep(300)
  }

  private val gattCallback = object : BluetoothGattServerCallback() {

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        connectedDevice = device
        sendEvent("onConnect", mapOf("address" to device.address))
        // Request higher MTU (Android default is 23, max 517)
        gattServer?.let {
          // Note: as peripheral, we can't initiate MTU request.
          // The central (dApp) must request MTU. We handle it in onMtuChanged.
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        if (connectedDevice?.address == device.address) {
          connectedDevice = null
          sendEvent("onDisconnect", mapOf("address" to device.address))
        }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice?, mtu: Int) {
      negotiatedMtu = mtu
      android.util.Log.i(TAG, "MTU changed to $mtu")
      sendEvent("onMtuChanged", mapOf("mtu" to mtu))
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice, requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray
    ) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      }
      val b64 = Base64.encodeToString(value, Base64.NO_WRAP)
      sendEvent("onWrite", mapOf("characteristicUuid" to characteristic.uuid.toString(), "value" to b64))
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice, requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean, responseNeeded: Boolean,
      offset: Int, value: ByteArray
    ) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      }
      if (descriptor.uuid == CCC_DESCRIPTOR_UUID) {
        val charUuid = descriptor.characteristic.uuid.toString()
        if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
          sendEvent("onSubscribe", mapOf("characteristicUuid" to charUuid))
        } else if (value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)) {
          sendEvent("onUnsubscribe", mapOf("characteristicUuid" to charUuid))
        }
      }
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice, requestId: Int,
      offset: Int, characteristic: BluetoothGattCharacteristic
    ) {
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset,
        characteristic.value ?: ByteArray(0))
    }
  }
}
