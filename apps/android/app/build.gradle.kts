plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val grogoniApiOrigin = providers.gradleProperty("GROGONI_API_ORIGIN")
    .orElse("https://grogoni.com/api")

android {
    namespace = "market.grogoni.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "market.grogoni.app"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "GROGONI_API_ORIGIN", "\"${grogoniApiOrigin.get()}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.2.1")
}
