import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val grogoniApiOrigin = providers.gradleProperty("GROGONI_API_ORIGIN")
    .orElse("https://grogoni.com/api")

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = if (keystorePropertiesFile.exists()) {
    Properties().apply { keystorePropertiesFile.inputStream().use { load(it) } }
} else {
    Properties()
}

val releaseStoreFile = System.getenv("GROGONI_RELEASE_STORE_FILE")
    ?: keystoreProperties.getProperty("storeFile")
    ?: ""
val releaseStorePassword = System.getenv("GROGONI_RELEASE_STORE_PASSWORD")
    ?: keystoreProperties.getProperty("storePassword")
    ?: ""
val releaseKeyAlias = System.getenv("GROGONI_RELEASE_KEY_ALIAS")
    ?: keystoreProperties.getProperty("keyAlias")
    ?: ""
val releaseKeyPassword = System.getenv("GROGONI_RELEASE_KEY_PASSWORD")
    ?: keystoreProperties.getProperty("keyPassword")
    ?: ""

android {
    namespace = "market.grogoni.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "market.grogoni.app"
        minSdk = 23
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "GROGONI_API_ORIGIN", "\"${grogoniApiOrigin.get()}\"")
    }

    signingConfigs {
        create("release") {
            if (releaseStoreFile.isNotBlank()) {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseStoreFile.isNotBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // Pin Java and Kotlin to the same bytecode target. Without this, javac defaults to 1.8 while
    // Kotlin follows the JDK running Gradle, and Kotlin 2.x fails the build on the mismatch.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
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
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.2.1")
}

// Do not produce an unsigned APK that can be mistaken for a distributable release.
val validateReleaseSigning by tasks.registering {
    doLast {
        require(releaseStoreFile.isNotBlank() && releaseStorePassword.isNotBlank() &&
            releaseKeyAlias.isNotBlank() && releaseKeyPassword.isNotBlank()) {
            "Configure the release keystore, alias and passwords before building a release APK or bundle."
        }
        require(file(releaseStoreFile).isFile) { "The configured release keystore does not exist." }
    }
}
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    dependsOn(validateReleaseSigning)
}

val verifySharedWebBundle by tasks.registering {
    doLast {
        require(file("src/main/assets/web/index.html").isFile && file("src/main/assets/web-bundle.json").isFile) {
            "Run pnpm android:web:bundle before building Android. Android hosts the shared web application."
        }
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(verifySharedWebBundle) }
