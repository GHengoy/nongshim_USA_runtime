from pypylon import pylon

CAMERA_IP = "192.168.1.100"  # ← 연결할 카메라 IP로 변경하세요

tl_factory = pylon.TlFactory.GetInstance()
device_info = pylon.CDeviceInfo()
device_info.SetIpAddress(CAMERA_IP)
camera = pylon.InstantCamera(tl_factory.CreateDevice(device_info))
camera.Open()

# demonstrate some feature access
new_width = camera.Width.Value - camera.Width.Inc
if new_width >= camera.Width.Min:
    camera.Width.Value = new_width

numberOfImagesToGrab = 100
camera.StartGrabbingMax(numberOfImagesToGrab)

while camera.IsGrabbing():
    grabResult = camera.RetrieveResult(5000, pylon.TimeoutHandling_ThrowException)

    if grabResult.GrabSucceeded():
        # Access the image data.
        print("SizeX: ", grabResult.Width)
        print("SizeY: ", grabResult.Height)
        img = grabResult.Array
        print("Gray value of first pixel: ", img[0, 0])

    grabResult.Release()
camera.Close()